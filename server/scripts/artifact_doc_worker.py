"""Bounded document processing entry point for DocWorkerSandbox."""

import json
import math
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
import subprocess
from urllib.parse import unquote, urlsplit
import zipfile

from lxml import etree as XML


CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
MAIN_PART = {"xlsx": "xl/workbook.xml", "docx": "word/document.xml", "pptx": "ppt/presentation.xml"}
MAX_UNCOMPRESSED = 200 * 1024 * 1024


def parse_xml(data):
    parser = XML.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
    root = XML.fromstring(data, parser)
    if root.getroottree().docinfo.doctype:
        raise ValueError("OOXML document types are forbidden")
    return root


def tag(namespace, name):
    return f"{{{namespace}}}{name}"


def checked_members(package):
    entries = package.infolist()
    if len(entries) > 2000 or sum(entry.file_size for entry in entries) > MAX_UNCOMPRESSED:
        raise ValueError("OOXML package exceeds expansion limits")
    names = set()
    for entry in entries:
        name = entry.filename
        if (
            not name or "\\" in name or name.startswith("/") or ":" in name
            or any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))
            or entry.orig_filename != name
            or (entry.external_attr >> 16) & 0o170000 == 0o120000
            or entry.flag_bits & 1
            or entry.file_size > max(1, entry.compress_size) * 100
            or name in names
        ):
            raise ValueError("Invalid or oversized OOXML package member")
        names.add(name)
    return {entry.filename for entry in entries if not entry.is_dir()}


def resolve_relationship(source_dir, target):
    uri = urlsplit(target)
    value = unquote(uri.path, errors="strict")
    if uri.netloc or uri.scheme or uri.query or "\\" in value or "\x00" in value:
        raise ValueError("Invalid internal relationship target")
    if not value:
        raise ValueError("Missing internal relationship target")
    dest = posixpath.normpath(value.lstrip("/") if value.startswith("/") else posixpath.join(source_dir, value))
    if dest == ".." or dest.startswith("../"):
        raise ValueError("Relationship escapes package")
    return dest


def validate_package(package, fmt):
    names = checked_members(package)
    if not {"[Content_Types].xml", "_rels/.rels", MAIN_PART[fmt]} <= names:
        raise ValueError("Required OOXML package parts are missing")
    types = parse_xml(package.read("[Content_Types].xml"))
    if types.tag != tag(CONTENT_TYPES, "Types"):
        raise ValueError("Invalid content types manifest")
    defaults, overrides = {}, {}
    for child in types:
        if child.tag == tag(CONTENT_TYPES, "Default"):
            key = child.get("Extension", "").lower()
            mapping = defaults
        elif child.tag == tag(CONTENT_TYPES, "Override"):
            key = resolve_relationship("", child.attrib["PartName"])
            if key not in names:
                raise ValueError("Content type override references a missing part")
            mapping = overrides
        else:
            raise ValueError("Invalid content type declaration")
        if not key or key in mapping or not child.get("ContentType"):
            raise ValueError("Invalid or duplicated content type declaration")
        mapping[key] = child.attrib["ContentType"]
    for name in sorted(names - {"[Content_Types].xml"}):
        content_type = overrides.get(name) or defaults.get(PurePosixPath(name).suffix.lstrip(".").lower())
        if name == "_rels/.rels":
            content_type = overrides.get(name) or defaults.get("rels")
        if not content_type:
            raise ValueError("OOXML package part has no content type")
        if name.endswith((".xml", ".rels")) or content_type.endswith(("+xml", "/xml")):
            part = parse_xml(package.read(name))
            if name.endswith(".rels"):
                parent = PurePosixPath(name).parent
                if parent.name != "_rels" or part.tag != tag(RELATIONSHIPS, "Relationships"):
                    raise ValueError("Invalid relationships part")
                seen_ids = set()
                for relationship in part:
                    identifier = relationship.get("Id")
                    if relationship.tag != tag(RELATIONSHIPS, "Relationship") or not identifier or identifier in seen_ids:
                        raise ValueError("Invalid or duplicate relationship identifier")
                    seen_ids.add(identifier)
                    if relationship.get("TargetMode") != "External":
                        target = resolve_relationship(str(parent.parent), relationship.attrib["Target"])
                        if target not in names:
                            raise ValueError("Internal relationship references a missing part")
    if fmt == "xlsx":
        validate_workbook_indices(package, names)
    return names


def validate_workbook_indices(package, names):
    shared_count = 0
    style_count = 0
    if "xl/sharedStrings.xml" in names:
        shared_count = len(parse_xml(package.read("xl/sharedStrings.xml")).findall(tag(SPREADSHEET, "si")))
    if "xl/styles.xml" in names:
        styles = parse_xml(package.read("xl/styles.xml")).find(tag(SPREADSHEET, "cellXfs"))
        if styles is not None:
            style_count = len(styles.findall(tag(SPREADSHEET, "xf")))
    sheets = workbook_sheets(package)
    if len({sheet["id"] for sheet in sheets}) != len(sheets):
        raise ValueError("Duplicate worksheet ID")
    for sheet in sheets:
        root = parse_xml(package.read(sheet["part"]))
        addresses = set()
        for cell in root.iter(tag(SPREADSHEET, "c")):
            address = cell.get("r")
            if address:
                cell_coordinates(address)
                if address in addresses:
                    raise ValueError("Duplicate worksheet cell address")
                addresses.add(address)
            style = cell.get("s")
            if style is not None:
                bounded_integer(style, 0, style_count - 1)
            if cell.get("t") == "s":
                bounded_integer(cell.findtext(tag(SPREADSHEET, "v")), 0, shared_count - 1)


def invalidate_calculation(package, replacements):
    """Clear stale cached formula values and remove all calcChain registrations."""
    workbook_name = MAIN_PART["xlsx"]
    workbook = parse_xml(package.read(workbook_name))
    calculation = workbook.find(tag(SPREADSHEET, "calcPr"))
    if calculation is None:
        calculation = XML.Element(tag(SPREADSHEET, "calcPr"))
        trailing = {"oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes",
                    "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"}
        index = next((i for i, node in enumerate(workbook) if isinstance(node.tag, str) and XML.QName(node).localname in trailing), len(workbook))
        workbook.insert(index, calculation)
    calculation.set("fullCalcOnLoad", "1")
    replacements[workbook_name] = workbook

    removed = set()
    rel_name = "xl/_rels/workbook.xml.rels"
    relations = parse_xml(package.read(rel_name))
    for relation in list(relations):
        if relation.get("Type", "").endswith("/calcChain") and relation.get("TargetMode") != "External":
            removed.add(resolve_relationship("xl", relation.attrib["Target"]))
            relations.remove(relation)
    if removed:
        replacements[rel_name] = relations
        types = parse_xml(package.read("[Content_Types].xml"))
        for item in list(types):
            if item.tag == tag(CONTENT_TYPES, "Override") and resolve_relationship("", item.attrib["PartName"]) in removed:
                types.remove(item)
        replacements["[Content_Types].xml"] = types

    for name in package.namelist():
        if not re.fullmatch(r"xl/worksheets/[^/]+\.xml", name):
            continue
        sheet = replacements.get(name)
        if sheet is None:
            sheet = parse_xml(package.read(name))
        for cell in sheet.iter(tag(SPREADSHEET, "c")):
            value = cell.find(tag(SPREADSHEET, "v"))
            if value is not None and cell.find(tag(SPREADSHEET, "f")) is not None:
                cell.remove(value)
                replacements[name] = sheet
    return removed


def edit_workbook(package, operations, output):
    replacements = {}
    for operation in operations:
        op = operation["op"]
        if op not in {"xlsx.set_cell", "xlsx.set_formula"}:
            raise ValueError("Unsupported XLSX operation")
        sheet_name = operation["sheetPart"]
        address = operation["address"]
        value = operation["value"]
        if not re.fullmatch(r"xl/worksheets/[^/]+\.xml", sheet_name):
            raise ValueError("Invalid worksheet part")
        cell_coordinates(address)
        if type(value) not in (str, bool, int, float, type(None)):
            raise ValueError("Expected a scalar cell value")
        sheet = replacements.get(sheet_name)
        if sheet is None:
            sheet = parse_xml(package.read(sheet_name))
        cells = [cell for cell in sheet.iter(tag(SPREADSHEET, "c")) if cell.get("r") == address]
        if len(cells) != 1:
            raise ValueError("The operation requires an existing, unique cell")
        cell = cells[0]
        formula = cell.find(tag(SPREADSHEET, "f"))
        if formula is not None and formula.get("t") not in (None, "normal"):
            raise ValueError("Shared, table, and array formulas are protected")
        for child in list(cell):
            if child.tag in (tag(SPREADSHEET, "v"), tag(SPREADSHEET, "is"), tag(SPREADSHEET, "f")):
                cell.remove(child)
        cell.attrib.pop("t", None)
        if op == "xlsx.set_formula":
            if not isinstance(value, str) or not value.startswith("=") or len(value) < 2 or len(value) > 8192:
                raise ValueError("Invalid formula text")
            formula = XML.Element(tag(SPREADSHEET, "f"))
            formula.text = value[1:]
            cell.insert(0, formula)
        elif isinstance(value, str):
            if len(value.encode("utf-16-le")) > 65534:
                raise ValueError("Cell value exceeds the Excel limit")
            cell.set("t", "inlineStr")
            inline = XML.Element(tag(SPREADSHEET, "is"))
            cell.insert(0, inline)
            text = XML.SubElement(inline, tag(SPREADSHEET, "t"))
            text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            text.text = value
        elif value is not None:
            value_element = XML.Element(tag(SPREADSHEET, "v"))
            cell.insert(0, value_element)
            if isinstance(value, bool):
                cell.set("t", "b")
                value_element.text = "1" if value else "0"
            else:
                value_element.text = json.dumps(value, allow_nan=False)
        replacements[sheet_name] = sheet

    removed = invalidate_calculation(package, replacements)
    write_package(package, replacements, output, "xlsx", removed)


def write_package(package, replacements, output, fmt, removed=()):
    with zipfile.ZipFile(output, "w") as edited:
        for entry in package.infolist():
            if entry.filename in removed:
                continue
            root = replacements.get(entry.filename)
            data = package.read(entry)
            if root is not None:
                data = XML.tostring(root, encoding="UTF-8", xml_declaration=True)
            edited.writestr(entry, data)
    with zipfile.ZipFile(output) as edited:
        validate_package(edited, fmt)


def bounded_integer(value, minimum, maximum):
    integer = int(value)
    if isinstance(value, bool) or isinstance(value, float) or not minimum <= integer <= maximum:
        raise ValueError("Integer parameter is out of bounds")
    return integer


def image_size(size):
    return tuple(bounded_integer(dimension, 1, 8192) for dimension in size)


def process_image(request, source, output):
    from PIL import Image, ImageDraw, ImageEnhance, ImageOps

    Image.MAX_IMAGE_PIXELS = 8192 * 8192
    action = request["action"]
    if action == "create":
        options = request["params"]
        image = Image.new("RGB", image_size((options["width"], options["height"])), options.get("color", "white"))
        image.save(output, format=image_encoding(request["filename"].split(".")[-1]))
        return None
    with Image.open(source) as original:
        width, height = image_size(original.size)
        encoding = original.format
        if action == "structure":
            return {"format": "image", "encoding": encoding, "width": width, "height": height, "mode": original.mode}
        if action == "verify":
            original.verify()
            return {"ok": True, "issues": [], "metrics": {"width": width, "height": height}}
        if action == "edit" and getattr(original, "is_animated", False):
            raise ValueError("Editing animated images is unsupported")
        image = ImageOps.exif_transpose(original).convert("RGBA")
    if action == "edit":
        for operation in request["operations"]:
            op = operation["op"]
            if op == "image.crop":
                left = bounded_integer(operation["left"], 0, image.width - 1)
                top = bounded_integer(operation["top"], 0, image.height - 1)
                right = bounded_integer(operation["right"], left + 1, image.width)
                bottom = bounded_integer(operation["bottom"], top + 1, image.height)
                image = image.crop((left, top, right, bottom))
            elif op == "image.resize":
                image = image.resize(image_size((operation["width"], operation["height"])), Image.Resampling.LANCZOS)
            elif op == "image.rotate":
                angle = bounded_integer(operation["degrees"], -360, 360)
                if angle % 90:
                    raise ValueError("Rotation must use a multiple of 90 degrees")
                image = image.rotate(angle, expand=True)
            elif op == "image.brightness":
                factor = float(operation["factor"])
                if not 0 <= factor <= 4:
                    raise ValueError("Brightness factor is out of bounds")
                image = ImageEnhance.Brightness(image).enhance(factor)
            elif op == "image.annotate":
                position = (bounded_integer(operation["x"], 0, image.width - 1),
                            bounded_integer(operation["y"], 0, image.height - 1))
                ImageDraw.Draw(image).text(position, operation["text"][:1000], fill=operation.get("color", "red"))
            else:
                raise ValueError("Unsupported image operation")
    elif action == "export":
        encoding = image_encoding(request["targetFormat"])
    elif action == "render":
        encoding = "PNG"
    else:
        raise ValueError("Unsupported image action")
    if encoding in {"JPEG", "BMP"}:
        image = image.convert("RGB")
    image.save(output, format=encoding)
    return None


def image_encoding(value):
    return {"png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "webp": "WEBP"}[value.lower()]


def process_pdf(request, source, output):
    from pypdf import PdfReader, PdfWriter
    from pypdf.annotations import FreeText, Text
    from pypdf.errors import PdfReadError

    action = request["action"]
    if action == "create":
        from reportlab.pdfgen.canvas import Canvas
        options = request["params"]
        pages = options.get("pages", [""])
        if not isinstance(pages, list) or not 1 <= len(pages) <= 100:
            raise ValueError("PDF must have between 1 and 100 pages")
        size = (bounded_integer(options.get("width", 612), 72, 2880),
                bounded_integer(options.get("height", 792), 72, 2880))
        canvas = Canvas(str(output), pagesize=size, invariant=1)
        for text in pages:
            y = size[1] - 36
            for line in text.splitlines()[:100]:
                canvas.drawString(36, y, line[:1000])
                y -= 14
            canvas.showPage()
        canvas.save()
        return None
    try:
        reader = PdfReader(source)
        if reader.is_encrypted:
            raise ValueError("Encrypted PDFs are unsupported")
        count = len(reader.pages)
    except PdfReadError as error:
        raise ValueError("Malformed PDF") from error
    if not 1 <= count <= 1000:
        raise ValueError("PDF page count is out of bounds")
    if action == "structure":
        return {"format": "pdf", "pageCount": count, "pages": [
            {"pageIndex": index, "widthPt": float(page.mediabox.width),
             "heightPt": float(page.mediabox.height), "rotation": page.rotation}
            for index, page in enumerate(reader.pages)
        ]}
    if action == "verify":
        for page in reader.pages:
            if not (0 < page.mediabox.width <= 14400 and 0 < page.mediabox.height <= 14400):
                raise ValueError("PDF page geometry is out of bounds")
        return {"ok": True, "issues": [], "metrics": {"pageCount": count}}
    if action == "range":
        first = bounded_integer(request["range"].get("pageIndex", 0), 0, count - 1)
        return {"pageIndex": first, "text": (reader.pages[first].extract_text() or "")[:50_000]}
    if action == "export" and request["targetFormat"] == "txt":
        with output.open("w", encoding="utf-8") as destination:
            remaining = 1_000_000
            for page in reader.pages:
                text = (page.extract_text() or "")[:remaining]
                destination.write(text + "\n")
                remaining -= len(text)
                if remaining <= 0:
                    break
        return None
    if action == "render" or (action == "export" and request["targetFormat"] == "png"):
        index = bounded_integer(request.get("pageIndex", 0), 0, count - 1)
        prefix = str(output) + "-image"
        subprocess.run(["pdftoppm", "-f", str(index + 1), "-l", str(index + 1), "-scale-to", "2048",
                        "-singlefile", "-png", str(source), prefix], check=True)
        Path(prefix + ".png").replace(output)
        return None
    if action != "edit":
        raise ValueError("Unsupported PDF action")

    writer = PdfWriter(clone_from=reader)
    for operation in request["operations"]:
        op = operation["op"]
        if op == "pdf.reorder_pages":
            order = operation["order"]
            if len(order) != len(writer.pages) or sorted(order) != list(range(len(writer.pages))):
                raise ValueError("The page order must be a complete permutation")
            # Reorder the page tree references without replacing the source page objects.
            if writer._pages.get_object()["/Count"] != len(writer._pages.get_object()["/Kids"]):
                raise ValueError("Nested PDF page trees cannot be reordered")
            from pypdf.generic import ArrayObject, NameObject
            page_tree = writer._pages.get_object()
            children = page_tree["/Kids"]
            page_tree[NameObject("/Kids")] = ArrayObject(children[index] for index in order)
        else:
            index = bounded_integer(operation["pageIndex"], 0, len(writer.pages) - 1)
            if op == "pdf.remove_page":
                if len(writer.pages) == 1:
                    raise ValueError("Cannot remove the final page")
                del writer.pages[index]
            elif op == "pdf.rotate_page":
                angle = bounded_integer(operation["degrees"], -360, 360)
                writer.pages[index].rotate(angle)
            elif op in {"pdf.add_note", "pdf.add_overlay"}:
                rect = tuple(float(coordinate) for coordinate in operation["rect"])
                if len(rect) != 4 or not all(math.isfinite(value) and abs(value) <= 14400 for value in rect) \
                        or rect[0] >= rect[2] or rect[1] >= rect[3]:
                    raise ValueError("Invalid annotation rectangle")
                text = operation["text"][:10_000]
                annotation = Text(text=text, rect=rect) if op == "pdf.add_note" else FreeText(text=text, rect=rect)
                writer.add_annotation(index, annotation)
            else:
                raise ValueError("Unsupported PDF operation")
    writer.write(output)
    return None


def media_info(source, demuxer):
    completed = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer,
                                "-show_entries", "format=format_name,duration:stream=index,codec_type,codec_name,width,height",
                                "-of", "json", str(source)], capture_output=True, check=True)
    data = json.loads(completed.stdout)
    if not data.get("streams") or not any(stream.get("codec_type") in {"audio", "video"} for stream in data["streams"]):
        raise ValueError("No audio or video stream found")
    for stream in data["streams"]:
        if stream.get("codec_type") == "video":
            image_size((stream["width"], stream["height"]))
    duration = float(data.get("format", {}).get("duration", 0))
    if not math.isfinite(duration) or duration < 0:
        raise ValueError("Invalid media duration")
    return {"format": "media", "durationSeconds": duration, "streams": data["streams"]}


def process_media(request, source, output):
    extension = request["filename"].rsplit(".", 1)[-1].lower()
    muxer = {"mp4": "mp4", "webm": "webm", "mp3": "mp3", "wav": "wav", "m4a": "ipod",
             "ogg": "ogg", "flac": "flac", "mov": "mov", "mkv": "matroska"}[extension]
    demuxer = {"mp4": "mov", "m4a": "mov", "webm": "matroska"}.get(extension, muxer)
    options = media_info(source, demuxer)
    action = request["action"]
    if action == "structure":
        return options
    if action == "verify":
        return {"ok": True, "issues": [], "metrics": options}
    command = ["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
               "-threads", "2", "-f", demuxer, "-i", str(source)]
    if action == "render":
        timestamp = float(request.get("timeSeconds", 0))
        if not 0 <= timestamp <= options["durationSeconds"]:
            raise ValueError("Frame timestamp is out of bounds")
        command += ["-ss", str(timestamp), "-map", "0:v:0", "-frames:v", "1",
                    "-vf", "scale=2048:2048:force_original_aspect_ratio=decrease", "-f", "image2", "-c:v", "png"]
    elif action == "edit":
        operations = request["operations"]
        if len(operations) != 1 or operations[0]["op"] != "media.trim":
            raise ValueError("Expected a single media.trim operation")
        start, end = (float(operations[0][key]) for key in ("startSeconds", "endSeconds"))
        if not 0 <= start < end <= options["durationSeconds"]:
            raise ValueError("Trim timestamps are out of bounds")
        command += ["-ss", str(start), "-t", str(end - start), "-map", "0:v:0?", "-map", "0:a:0?", "-f", muxer]
    else:
        raise ValueError("Unsupported media action")
    subprocess.run(command + [str(output)], check=True)
    return None


WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"
DIAGRAM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def text_content(node, namespace):
    return "".join(text.text or "" for text in node.iter(tag(namespace, "t")))[:10_000]


def pptx_shape_order(node, depth=0):
    if depth > 20:
        raise ValueError("Presentation group nesting is too deep")
    children = []
    for shape in node:
        if not isinstance(shape.tag, str) or XML.QName(shape).localname not in {
            "sp", "pic", "graphicFrame", "cxnSp", "grpSp", "contentPart"
        }:
            continue
        props = shape.find("./*/" + tag(PRESENTATION, "cNvPr"))
        if props is None:
            continue
        children.append({"id": props.get("id"), "name": props.get("name"), "type": XML.QName(shape).localname,
                         "text": text_content(shape, DRAWING), "zOrder": len(children),
                         "children": pptx_shape_order(shape, depth + 1)})
        if len(children) > 1000:
            raise ValueError("Presentation shape limit exceeded")
    return children


def workbook_sheets(package):
    root = parse_xml(package.read(MAIN_PART["xlsx"]))
    relations = parse_xml(package.read("xl/_rels/workbook.xml.rels"))
    paths = {relation.get("Id"): resolve_relationship("xl", relation.attrib["Target"])
             for relation in relations if relation.get("Type", "").endswith("/worksheet")
             and relation.get("TargetMode") != "External"}
    return [{"id": node.get("sheetId"), "name": node.get("name"), "part": paths[node.get(tag(OFFICE_REL, "id"))]}
            for node in root.iter(tag(SPREADSHEET, "sheet")) if node.get(tag(OFFICE_REL, "id")) in paths]


CELL_ADDRESS = re.compile(r"([A-Z]{1,3})([1-9][0-9]{0,6})")


def cell_coordinates(address):
    match = CELL_ADDRESS.fullmatch(address)
    if not match:
        raise ValueError("Invalid worksheet address")
    column = 0
    for letter in match.group(1):
        column = column * 26 + ord(letter) - ord("A") + 1
    return bounded_integer(match.group(2), 1, 1048576), bounded_integer(column, 1, 16384)


def read_workbook_range(package, options):
    sheet = next((sheet for sheet in workbook_sheets(package) if sheet["id"] == str(options["sheetId"])), None)
    if sheet is None:
        raise ValueError("Unknown worksheet")
    bounds = options.get("rangeA1", "A1").split(":")
    first_row, first_column = cell_coordinates(bounds[0])
    last_row, last_column = cell_coordinates(bounds[-1])
    if len(bounds) > 2 or first_row > last_row or first_column > last_column \
            or (last_row - first_row + 1) * (last_column - first_column + 1) > 1000:
        raise ValueError("Requested worksheet range is out of bounds")
    worksheet = parse_xml(package.read(sheet["part"]))
    shared = None
    if "xl/sharedStrings.xml" in package.namelist():
        shared = parse_xml(package.read("xl/sharedStrings.xml"))
    cells = []
    for cell in worksheet.iter(tag(SPREADSHEET, "c")):
        address = cell.get("r")
        if not address:
            continue
        row, column = cell_coordinates(address)
        if not (first_row <= row <= last_row and first_column <= column <= last_column):
            continue
        formula = cell.find(tag(SPREADSHEET, "f"))
        value = cell.findtext(tag(SPREADSHEET, "v"))
        cell_type = cell.get("t")
        if cell_type == "s" and value is not None:
            if shared is None:
                raise ValueError("Worksheet references missing shared strings")
            value = text_content(shared[bounded_integer(value, 0, len(shared) - 1)], SPREADSHEET)
        elif cell_type == "inlineStr":
            value = text_content(cell, SPREADSHEET)
        record = {"address": address, "value": value, "type": cell_type}
        if formula is not None:
            record.update(formula=formula.text, formulaStatus=(
                "error_formula" if cell_type == "e" else
                "cached_existing" if value not in (None, "") else "unevaluated_unsupported"
            ))
        cells.append(record)
    return {"sheetId": sheet["id"], "rangeA1": options.get("rangeA1", "A1"), "cells": cells}


def edit_word(package, operations, output):
    main_part = MAIN_PART["docx"]
    document = parse_xml(package.read(main_part))
    body = document.find(tag(WORD, "body"))
    for operation in operations:
        op = operation["op"]
        if op == "docx.set_paragraph_text":
            index = bounded_integer(operation["blockIndex"], 0, len(body) - 1)
            block = body[index]
            if block.tag != tag(WORD, "p"):
                raise ValueError("Only plain paragraphs support this edit")
            runs = [run for run in block if run.tag != tag(WORD, "pPr")]
            if len(runs) != 1 or runs[0].tag != tag(WORD, "r"):
                raise ValueError("Paragraph contains protected content or mixed formatting")
            contents = [node for node in runs[0] if node.tag != tag(WORD, "rPr")]
            if len(contents) != 1 or contents[0].tag != tag(WORD, "t"):
                raise ValueError("Paragraph contains protected content")
            text = operation["text"]
            if len(text) > 20_000 or "\n" in text or "\r" in text:
                raise ValueError("Use one bounded line of text")
            contents[0].set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            contents[0].text = text
        elif op == "docx.set_page_size":
            section = body.find(tag(WORD, "sectPr"))
            size = None if section is None else section.find(tag(WORD, "pgSz"))
            if size is None:
                raise ValueError("Document has no terminal page size entry")
            width = bounded_integer(operation["widthTwips"], 1440, 31680)
            height = bounded_integer(operation["heightTwips"], 1440, 31680)
            size.set(tag(WORD, "w"), str(width))
            size.set(tag(WORD, "h"), str(height))
            size.set(tag(WORD, "orient"), "landscape" if width > height else "portrait")
        else:
            raise ValueError("Unsupported Word operation")
    write_package(package, {main_part: document}, output, "docx")


def edit_presentation(package, operations, output):
    replacements = {}
    for operation in operations:
        slide = operation["slidePart"]
        if not re.fullmatch(r"ppt/slides/[^/]+\.xml", slide):
            raise ValueError("Invalid slide part")
        root = replacements.get(slide)
        if root is None:
            root = parse_xml(package.read(slide))
        tree = root.find(".//" + tag(PRESENTATION, "spTree"))
        shapes = []
        for shape in tree:
            properties = shape.find("./*/" + tag(PRESENTATION, "cNvPr"))
            if properties is not None and properties.get("id") == str(operation["shapeId"]):
                shapes.append(shape)
        if len(shapes) != 1:
            raise ValueError("Expected a unique top-level shape")
        shape = shapes[0]
        if operation["op"] == "pptx.set_shape_text":
            run = shape.findall(".//" + tag(DRAWING, "r"))
            if len(run) != 1 or len(shape.findall(".//" + tag(DRAWING, "p"))) != 1:
                raise ValueError("Shape contains multiple paragraphs or runs")
            text = run[0].find(tag(DRAWING, "t"))
            text.text = operation["text"][:20_000]
        elif operation["op"] == "pptx.move_shape":
            index = bounded_integer(operation["zOrder"], 0, len(pptx_shape_order(tree)) - 1)
            peers = [node for node in tree if node.find("./*/" + tag(PRESENTATION, "cNvPr")) is not None]
            tree.remove(shape)
            peers.remove(shape)
            if index < len(peers):
                tree.insert(tree.index(peers[index]), shape)
            else:
                extension = tree.find(tag(PRESENTATION, "extLst"))
                tree.insert(tree.index(extension) if extension is not None else len(tree), shape)
        else:
            raise ValueError("Unsupported presentation operation")
        replacements[slide] = root
    write_package(package, replacements, output, "pptx")


def create_office(request, output):
    fmt, options = request["format"], request["params"]
    if fmt == "docx":
        from docx import Document
        document = Document()
        for paragraph in options.get("paragraphs", [])[:1000]:
            document.add_paragraph(paragraph[:20_000])
    elif fmt == "pptx":
        from pptx import Presentation
        document = Presentation()
        for slide in options.get("slides", [])[:100]:
            page = document.slides.add_slide(document.slide_layouts[1])
            page.shapes.title.text = slide.get("title", "")[:2000]
            page.placeholders[1].text = slide.get("text", "")[:20_000]
    else:
        from openpyxl import Workbook
        document = Workbook()
        for row in options.get("rows", [])[:1000]:
            document.active.append(row[:100])
    document.save(output)
    with zipfile.ZipFile(output) as package:
        validate_package(package, fmt)


def render_office(source, output, request):
    fmt = request["format"]
    staging = Path.cwd() / ("source." + fmt)
    staging.write_bytes(source.read_bytes())
    subprocess.run(["libreoffice", "-env:UserInstallation=" + (Path.cwd() / "office-profile").as_uri(),
                    "--headless", "--convert-to", "pdf", "--outdir", str(Path.cwd()), str(staging)],
                   check=True)
    pdf = staging.with_suffix(".pdf")
    if request["action"] == "export":
        pdf.replace(output)
    else:
        process_pdf({**request, "format": "pdf"}, pdf, output)


def process_document(request, source, output):
    fmt = request["format"]
    if fmt == "image":
        return process_image(request, source, output)
    if fmt == "pdf":
        return process_pdf(request, source, output)
    if fmt == "media":
        return process_media(request, source, output)
    if fmt == "svg" and request["action"] == "render":
        root = parse_xml(source.read_bytes())
        if root.tag != "{http://www.w3.org/2000/svg}svg":
            raise ValueError("Expected an SVG image")
        subprocess.run(["rsvg-convert", "--keep-aspect-ratio", "-w", "2048", "-h", "2048",
                        "-o", str(output)], input=XML.tostring(root), check=True)
        return None
    action = request["action"]
    if action == "create":
        create_office(request, output)
        return None

    with zipfile.ZipFile(source) as package:
        names = validate_package(package, fmt)
        if action == "render" or (action == "export" and request["targetFormat"] == "pdf"):
            render_office(source, output, request)
            return None
        if action == "edit":
            editors = {"xlsx": edit_workbook, "docx": edit_word, "pptx": edit_presentation}
            editors[fmt](package, request["operations"], output)
            return None
        if action == "verify":
            return {"ok": True, "issues": [], "metrics": {"packageParts": len(names)}}
        if action == "range" and fmt == "xlsx":
            return read_workbook_range(package, request["range"])
        main = parse_xml(package.read(MAIN_PART[fmt]))
        result = {"format": fmt, "packageParts": len(names)}
        if fmt == "xlsx" and action == "structure":
            return {**result, "sheets": workbook_sheets(package)}
        if fmt == "docx" and action in {"structure", "range"}:
            body = main.find(tag(WORD, "body"))
            options = request.get("range", {})
            start = bounded_integer(options.get("start", 0), 0, len(body))
            count = bounded_integer(options.get("count", 50), 1, 100)
            return {**result, "blockCount": len(body), "blocks": [
                {"blockIndex": index, "type": XML.QName(node).localname, "text": text_content(node, WORD)}
                for index, node in enumerate(body, start=0)
                if start <= index < start + count and isinstance(node.tag, str)
            ]}
        if fmt == "pptx" and action in {"structure", "range"}:
            slides = sorted(name for name in names if re.fullmatch(r"ppt/slides/[^/]+\.xml", name))
            diagrams = sorted(name for name in names if re.fullmatch(r"ppt/diagrams/data[^/]+\.xml", name))
            if action == "structure":
                return {**result, "slideParts": slides, "smartArtParts": diagrams}
            part = request["range"]["part"]
            if part not in slides and part not in diagrams:
                raise ValueError("Unknown slide or SmartArt part")
            root = parse_xml(package.read(part))
            if part in diagrams:
                return {**result, "part": part,
                        "nodes": [{"id": node.get("modelId"), "type": node.get("type"), "text": text_content(node, DRAWING)}
                                  for node in root.iter(tag(DIAGRAM, "pt"))][:1000],
                        "connections": [dict(node.attrib) for node in root.iter(tag(DIAGRAM, "cxn"))][:1000]}
            return {**result, "part": part, "shapes": pptx_shape_order(root.find(".//" + tag(PRESENTATION, "spTree")))}
    raise ValueError("Unsupported document worker action")


def main():
    input_dir = Path(os.environ["AGY_WORKER_IN_DIR"])
    request = json.loads((input_dir / "request.json").read_text(encoding="utf-8"))
    output = Path(os.environ["AGY_WORKER_OUT_DIR"]) / "result"
    result = process_document(request, input_dir / "document", output)
    if result is not None:
        output.write_text(json.dumps(result, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, XML.LxmlError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
