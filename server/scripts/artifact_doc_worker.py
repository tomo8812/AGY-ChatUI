"""Bounded document processing entry point for DocWorkerSandbox."""

import base64
import csv
import json
import io
from copy import copy, deepcopy
import math
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
import subprocess
import tempfile
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
        if not isinstance(child.tag, str):
            continue
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
                    if not isinstance(relationship.tag, str):
                        continue
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
    workbook = replacements.get(workbook_name)
    if workbook is None:
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
    changes_cells = False
    for operation in operations:
        op = operation["op"]
        if op.startswith("chart."):
            changes_cells |= edit_chart(package, "xlsx", operation, replacements)
            continue
        changes_cells |= op != "xlsx.set_cell_style"
        if op in {"xlsx.mutate_rows", "xlsx.mutate_columns"}:
            mutate_workbook_grid(package, operation, replacements)
        else:
            update_workbook_cell(package, operation, replacements)
    removed = invalidate_calculation(package, replacements) if changes_cells else ()
    write_package(package, replacements, output, "xlsx", removed)


def locate_or_insert_cell(sheet, address):
    row_number, column_number = cell_coordinates(address)
    grid = sheet.find(tag(SPREADSHEET, "sheetData"))
    if grid is None:
        raise ValueError("Worksheet has no cell data")
    row = None
    offset = len(grid)
    for index, candidate in enumerate(grid):
        if candidate.tag != tag(SPREADSHEET, "row"):
            continue
        number = bounded_integer(candidate.get("r"), 1, 1048576)
        if number == row_number:
            row = candidate
            break
        if number > row_number:
            offset = index
            break
    if row is None:
        row = XML.Element(tag(SPREADSHEET, "row"), r=str(row_number))
        grid.insert(offset, row)
    offset = len(row)
    for index, previous in enumerate(row):
        if previous.tag != tag(SPREADSHEET, "c"):
            offset = index
            break
        column = cell_coordinates(previous.attrib["r"])[1]
        if column == column_number:
            return previous
        if column > column_number:
            offset = index
            break
    cell = XML.Element(tag(SPREADSHEET, "c"), r=address)
    row.insert(offset, cell)
    dimension = sheet.find(tag(SPREADSHEET, "dimension"))
    if dimension is not None and dimension.get("ref"):
        corners = dimension.attrib["ref"].split(":")
        first_row, first_column = cell_coordinates(corners[0])
        last_row, last_column = cell_coordinates(corners[-1])
        start = f"{column_name(min(first_column, column_number))}{min(first_row, row_number)}"
        end = f"{column_name(max(last_column, column_number))}{max(last_row, row_number)}"
        dimension.set("ref", start if start == end else f"{start}:{end}")
    row.attrib.pop("spans", None)
    return cell


def assert_editable_cell(sheet, address):
    row, column = cell_coordinates(address)
    for merged in sheet.iter(tag(SPREADSHEET, "mergeCell")):
        start, end = merged.attrib["ref"].split(":")
        first_row, first_column = cell_coordinates(start)
        last_row, last_column = cell_coordinates(end)
        if address != start and first_row <= row <= last_row and first_column <= column <= last_column:
            raise ValueError("Select the anchor of a merged cell")
    for formula in sheet.iter(tag(SPREADSHEET, "f")):
        if formula.get("t") not in {"shared", "array", "dataTable"} or not formula.get("ref"):
            continue
        bounds = formula.attrib["ref"].split(":")
        first_row, first_column = cell_coordinates(bounds[0])
        last_row, last_column = cell_coordinates(bounds[-1])
        if first_row <= row <= last_row and first_column <= column <= last_column:
            raise ValueError("Shared, table, and array formulas are protected")


def update_workbook_cell(package, operation, replacements):
    op = operation["op"]
    if op not in {"xlsx.set_cell", "xlsx.set_formula", "xlsx.set_cell_style"}:
        raise ValueError("Unsupported XLSX operation")
    sheet_name = operation["sheetPart"]
    address = operation["address"]
    value = operation.get("value")
    if not re.fullmatch(r"xl/worksheets/[^/]+\.xml", sheet_name):
        raise ValueError("Invalid worksheet part")
    cell_coordinates(address)
    if type(value) not in (str, bool, int, float, type(None)):
        raise ValueError("Expected a scalar cell value")
    sheet = replacements.get(sheet_name)
    if sheet is None:
        sheet = parse_xml(package.read(sheet_name))
    assert_editable_cell(sheet, address)
    cell = locate_or_insert_cell(sheet, address)
    if op == "xlsx.set_cell_style":
        cell.set("s", str(bounded_integer(operation["styleIndex"], 0, 65535)))
        replacements[sheet_name] = sheet
        return
    if cell.get("t") == "s" and "xl/sharedStrings.xml" in package.namelist():
        strings = replacements.get("xl/sharedStrings.xml")
        if strings is None:
            strings = parse_xml(package.read("xl/sharedStrings.xml"))
        strings.attrib.pop("count", None)
        replacements["xl/sharedStrings.xml"] = strings
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


def write_package(package, replacements, output, fmt, removed=(), additions=None):
    with zipfile.ZipFile(output, "w") as edited:
        for entry in package.infolist():
            if entry.filename in removed:
                continue
            root = replacements.get(entry.filename)
            data = package.read(entry)
            if isinstance(root, bytes):
                data = root
            elif root is not None:
                data = XML.tostring(root, encoding="UTF-8", xml_declaration=True)
            edited.writestr(copy(entry), data)
        for name, data in (additions or {}).items():
            edited.writestr(name, data, zipfile.ZIP_DEFLATED)
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
            elif op == "image.composite":
                encoded = operation["imageBase64"]
                if not isinstance(encoded, str) or len(encoded) > 2_000_000:
                    raise ValueError("Overlay image exceeds the input limit")
                with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as overlay:
                    overlay_size = image_size(overlay.size)
                    left = bounded_integer(operation["x"], 0, image.width - 1)
                    top = bounded_integer(operation["y"], 0, image.height - 1)
                    if left + overlay_size[0] > image.width or top + overlay_size[1] > image.height:
                        raise ValueError("Overlay extends beyond the canvas")
                    image.alpha_composite(overlay.convert("RGBA"), (left, top))
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
    from pypdf.annotations import Text
    from pypdf.errors import PdfReadError

    action = request["action"]
    if action == "create":
        merge_count = bounded_integer(request.get("mergeSourceCount", 0), 0, 10)
        if merge_count:
            writer = PdfWriter()
            for index in range(merge_count):
                reader = PdfReader(source.parent / f"merge-{index}.pdf")
                if reader.is_encrypted or len(writer.pages) + len(reader.pages) > 1000:
                    raise ValueError("PDF merge sources are encrypted or contain too many pages")
                writer.append(reader, import_outline=False)
            if not writer.pages:
                raise ValueError("PDF merge contains no pages")
            writer.write(output)
            return None
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
                if op == "pdf.add_note":
                    writer.add_annotation(index, Text(text=text, rect=rect))
                else:
                    from reportlab.pdfgen.canvas import Canvas
                    drawing = io.BytesIO()
                    original = writer.pages[index]
                    width, height = float(original.mediabox.width), float(original.mediabox.height)
                    if not 0 < width <= 14400 or not 0 < height <= 14400:
                        raise ValueError("PDF overlay page geometry is out of bounds")
                    canvas = Canvas(drawing, pagesize=(width, height), invariant=1)
                    canvas.drawString(rect[0], rect[1], text.splitlines()[0][:1000] if text else "")
                    canvas.save()
                    drawing.seek(0)
                    original.merge_page(PdfReader(drawing).pages[0])
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


def shape_transform(shape):
    transform = next((node for node in (
        shape.find("./" + tag(PRESENTATION, "spPr") + "/" + tag(DRAWING, "xfrm")),
        shape.find("./" + tag(PRESENTATION, "grpSpPr") + "/" + tag(DRAWING, "xfrm")),
        shape.find(tag(PRESENTATION, "xfrm")),
    ) if node is not None), None)
    if transform is None:
        return None
    coordinates = {}
    for element_name, attributes in (("off", ("x", "y")), ("ext", ("cx", "cy")),
                                     ("chOff", ("x", "y")), ("chExt", ("cx", "cy"))):
        element = transform.find(tag(DRAWING, element_name))
        if element is not None:
            coordinates[element_name] = [int(element.get(attribute, "0")) / 12700 for attribute in attributes]
    if "off" in coordinates and "ext" in coordinates:
        x, y = coordinates["off"]
        width, height = coordinates["ext"]
        coordinates["geomBoundsPt"] = {"x": x, "y": y, "width": width, "height": height}
    coordinates["rotationDegrees"] = int(transform.get("rot", "0")) / 60000
    coordinates["flipH"] = transform.get("flipH") in ("1", "true")
    coordinates["flipV"] = transform.get("flipV") in ("1", "true")
    return coordinates


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
                         "transform": shape_transform(shape), "children": pptx_shape_order(shape, depth + 1)})
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


def column_name(column):
    result = ""
    while column:
        column, digit = divmod(column - 1, 26)
        result = chr(ord("A") + digit) + result
    return result


MUTATION_ADDRESS = re.compile(r"(\$?)([A-Z]{1,3})(\$?)([1-9][0-9]{0,6})", re.IGNORECASE)


class UnsupportedStructuralMutation(ValueError):
    pass


class GridMutation:
    def __init__(self, operation):
        self.axis = 0 if operation["op"] == "xlsx.mutate_rows" else 1
        self.limit = 1048576 if self.axis == 0 else 16384
        self.index = bounded_integer(operation["index"], 1, self.limit)
        self.count = bounded_integer(operation.get("count", 1), 1, min(1000, self.limit - self.index + 1))
        self.mode = operation["mode"]
        if self.mode not in {"insert", "delete"}:
            raise ValueError("Unknown grid mutation mode")

    def interval(self, start, end):
        if self.mode == "insert":
            if self.index <= start:
                start += self.count
            if self.index <= end:
                end += self.count
        else:
            stop = self.index + self.count - 1
            if start >= self.index and end <= stop:
                return None
            start = start - self.count if start > stop else min(start, self.index)
            end = end - self.count if end > stop else min(end, self.index - 1)
        if start > end or end > self.limit:
            raise UnsupportedStructuralMutation("Grid mutation would move a reference outside the worksheet")
        return start, end

    def reference(self, value):
        endpoints = value.split(":")
        if len(endpoints) > 2 or any(not MUTATION_ADDRESS.fullmatch(point) for point in endpoints):
            raise UnsupportedStructuralMutation("Workbook contains a reference form that cannot be shifted")
        coordinates = [list(cell_coordinates(point.replace("$", "").upper())) for point in endpoints]
        shifted = self.interval(coordinates[0][self.axis], coordinates[-1][self.axis])
        if shifted is None:
            return None
        changed = []
        for index, point in enumerate(endpoints):
            coords = coordinates[index]
            coords[self.axis] = shifted[0] if index == 0 else shifted[1]
            column_prefix, _, row_prefix, _ = MUTATION_ADDRESS.fullmatch(point).groups()
            changed.append(f"{column_prefix}{column_name(coords[1])}{row_prefix}{coords[0]}")
        return ":".join(changed)


def rewrite_workbook_formula(expression, current_sheet, target_sheet, mutation):
    from openpyxl.formula import Tokenizer
    from openpyxl.formula.tokenizer import TokenizerError

    if not expression:
        return expression
    try:
        tokens = Tokenizer("=" + expression).items
    except TokenizerError as error:
        raise UnsupportedStructuralMutation("Workbook contains an unsupported formula") from error
    rewritten = []
    for token in tokens:
        value = token.value
        if token.type == "FUNC" and token.subtype == "OPEN" and value[:-1].upper().rsplit(".", 1)[-1] in {"INDIRECT", "OFFSET"}:
            raise UnsupportedStructuralMutation("Dynamic references cannot be shifted safely")
        if token.type == "OPERAND" and token.subtype == "RANGE":
            prefix, delimiter, reference = value.rpartition("!")
            qualifier = prefix.removeprefix("'").removesuffix("'").replace("''", "'") if delimiter else current_sheet
            if delimiter and ("[" in qualifier or "]" in qualifier or ":" in qualifier):
                raise UnsupportedStructuralMutation("External and three-dimensional references cannot be shifted safely")
            if qualifier and qualifier.casefold() == target_sheet.casefold():
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]*", reference) or MUTATION_ADDRESS.fullmatch(reference):
                    relocated = mutation.reference(reference)
                    value = prefix + delimiter + relocated if relocated else "#REF!"
        rewritten.append(value)
    return "".join(rewritten)


def mutate_workbook_grid(package, operation, replacements):
    mutation = GridMutation(operation)
    if any(name.startswith(("xl/pivot", "xl/tables/", "xl/drawings/", "xl/externalLinks/", "xl/comments"))
           for name in package.namelist()):
        raise UnsupportedStructuralMutation("Pivot tables, structured tables, drawings, comments and external links are protected")
    sheets = workbook_sheets(package)
    target = next((sheet for sheet in sheets if sheet["id"] == str(operation["sheetId"])), None)
    if target is None:
        raise ValueError("Unknown worksheet")
    for sheet in sheets:
        part = sheet["part"]
        root = replacements.get(part)
        if root is None:
            root = parse_xml(package.read(part))
        for formula in root.iter(tag(SPREADSHEET, "f")):
            if formula.get("t") not in (None, "normal"):
                raise UnsupportedStructuralMutation("Shared, table, and array formulas are protected")
            formula.text = rewrite_workbook_formula(formula.text, sheet["name"], target["name"], mutation)
        if sheet == target:
            shift_worksheet_grid(root, mutation)
        replacements[part] = root

    workbook_part = MAIN_PART["xlsx"]
    workbook = replacements.get(workbook_part)
    if workbook is None:
        workbook = parse_xml(package.read(workbook_part))
    for name in workbook.iter(tag(SPREADSHEET, "definedName")):
        local_id = name.get("localSheetId")
        sheet_name = sheets[bounded_integer(local_id, 0, len(sheets) - 1)]["name"] if local_id is not None else None
        if not sheet_name and name.text and "!" not in name.text and re.search(r"[A-Z][0-9]", name.text):
            raise UnsupportedStructuralMutation("Unqualified workbook-level defined name cannot be shifted safely")
        name.text = rewrite_workbook_formula(name.text, sheet_name, target["name"], mutation)
    replacements[workbook_part] = workbook


def shift_worksheet_grid(root, mutation):
    unsupported = ("conditionalFormatting", "dataValidations", "hyperlinks", "pane", "autoFilter", "extLst")
    if any(root.find(".//" + tag(SPREADSHEET, name)) is not None for name in unsupported):
        raise UnsupportedStructuralMutation("Worksheet contains protected ranges or view settings")
    for row in list(root.iter(tag(SPREADSHEET, "row"))):
        if mutation.axis == 0:
            index = bounded_integer(row.get("r"), 1, 1048576)
            updated = mutation.interval(index, index)
            if updated is None:
                row.getparent().remove(row)
                continue
            row.set("r", str(updated[0]))
        row.attrib.pop("spans", None)
        for cell in list(row.findall(tag(SPREADSHEET, "c"))):
            changed = mutation.reference(cell.attrib["r"])
            if changed is None:
                row.remove(cell)
            else:
                cell.set("r", changed)
    if mutation.axis == 1:
        for column in list(root.iter(tag(SPREADSHEET, "col"))):
            updated = mutation.interval(bounded_integer(column.get("min"), 1, 16384),
                                        bounded_integer(column.get("max"), 1, 16384))
            if updated is None:
                column.getparent().remove(column)
            else:
                column.set("min", str(updated[0]))
                column.set("max", str(updated[1]))
    for node in root.iter(tag(SPREADSHEET, "dimension")):
        node.set("ref", mutation.reference(node.attrib["ref"]) or "A1")
    merge_lists = list(root.iter(tag(SPREADSHEET, "mergeCells")))
    for merge_list in merge_lists:
        for merged in list(merge_list.findall(tag(SPREADSHEET, "mergeCell"))):
            updated = mutation.reference(merged.attrib["ref"])
            if updated is None or ":" not in updated or len(set(updated.split(":"))) == 1:
                merge_list.remove(merged)
            else:
                merged.set("ref", updated)
        if len(merge_list):
            merge_list.set("count", str(len(merge_list)))
        else:
            merge_list.getparent().remove(merge_list)
    for selection in root.iter(tag(SPREADSHEET, "selection")):
        for attribute in ("activeCell", "sqref"):
            if selection.get(attribute):
                selection.set(attribute, " ".join(
                    changed for ref in selection.get(attribute).split()
                    if (changed := mutation.reference(ref))
                ) or "A1")


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


SAFE_CALC_FUNCTIONS = {
    "ABS", "AND", "AVERAGE", "COUNT", "COUNTA", "IF", "IFERROR", "MAX", "MIN",
    "NOT", "OR", "ROUND", "ROUNDDOWN", "ROUNDUP", "SUM", "SUMIF", "SUMIFS",
}


def safe_to_evaluate_workbook(package):
    from openpyxl.formula import Tokenizer
    from openpyxl.formula.tokenizer import TokenizerError

    names = package.namelist()
    if any(name.startswith("xl/externalLinks/") or name.lower().endswith(("vbaproject.bin", ".xlam"))
           for name in names):
        return False
    for name in names:
        if name.endswith(".rels"):
            relationships = parse_xml(package.read(name))
            if any(relation.get("TargetMode") == "External" for relation in relationships):
                return False
    for sheet in workbook_sheets(package):
        root = parse_xml(package.read(sheet["part"]))
        for formula in root.iter(tag(SPREADSHEET, "f")):
            if not formula.text or formula.get("t") not in (None, "normal"):
                return False
            try:
                tokens = Tokenizer("=" + formula.text).items
            except TokenizerError:
                return False
            for token in tokens:
                if token.type == "FUNC" and token.subtype == "OPEN" and token.value[:-1].upper() not in SAFE_CALC_FUNCTIONS:
                    return False
                if token.type == "OPERAND" and token.subtype == "RANGE":
                    address = token.value.rsplit("!", 1)[-1].replace("$", "")
                    if not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?", address):
                        return False
                    if "[" in token.value or "]" in token.value:
                        return False
    return True


def evaluate_workbook_range(package, source, options, result):
    if not safe_to_evaluate_workbook(package):
        return result
    with tempfile.TemporaryDirectory(prefix="calc-", dir=Path.cwd()) as scratch:
        root = Path(scratch)
        original = root / "workbook.xlsx"
        original.write_bytes(source.read_bytes())
        converted = root / "converted"
        converted.mkdir()
        try:
            subprocess.run(["libreoffice", "-env:UserInstallation=" + (root / "profile").as_uri(),
                            "--headless", "--convert-to", "xlsx:Calc MS Excel 2007 XML",
                            "--outdir", str(converted), str(original)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            with zipfile.ZipFile(converted / original.name) as evaluated:
                original_name = next(sheet["name"] for sheet in workbook_sheets(package)
                                     if sheet["id"] == result["sheetId"])
                sheet_id = next(sheet["id"] for sheet in workbook_sheets(evaluated)
                                if sheet["name"] == original_name)
                calculated = read_workbook_range(evaluated, {**options, "sheetId": sheet_id})
        except (OSError, ValueError, LookupError, zipfile.BadZipFile, subprocess.CalledProcessError):
            return result
    evaluated_cells = {cell["address"]: cell for cell in calculated["cells"]}
    for cell in result["cells"]:
        if "formulaStatus" not in cell:
            continue
        evaluated = evaluated_cells.get(cell["address"])
        if not evaluated or "formulaStatus" not in evaluated:
            continue
        state = evaluated["formulaStatus"]
        if state in {"cached_existing", "error_formula"}:
            cell["value"] = evaluated["value"]
            cell["formulaStatus"] = "evaluated_lo" if state == "cached_existing" else "error_formula"
    return result


def update_word_page_layout(body, operation):
    section = body.find(tag(WORD, "sectPr"))
    if section is None:
        raise ValueError("Document has no terminal section")
    size = section.find(tag(WORD, "pgSz"))
    if size is None:
        raise ValueError("Document has no terminal page size entry")
    width = bounded_integer(operation.get("widthTwips", size.get(tag(WORD, "w"))), 1440, 31680)
    height = bounded_integer(operation.get("heightTwips", size.get(tag(WORD, "h"))), 1440, 31680)
    size.set(tag(WORD, "w"), str(width))
    size.set(tag(WORD, "h"), str(height))
    size.set(tag(WORD, "orient"), "landscape" if width > height else "portrait")

    if "marginsTwips" in operation:
        requested = operation["marginsTwips"]
        margins = section.find(tag(WORD, "pgMar"))
        if margins is None:
            margins = XML.Element(tag(WORD, "pgMar"))
            section.insert(section.index(size) + 1, margins)
        defaults = {"top": 1440, "right": 1440, "bottom": 1440, "left": 1440,
                    "header": 720, "footer": 720, "gutter": 0}
        if set(requested) - set(defaults):
            raise ValueError("Unknown page margin option")
        values = {key: bounded_integer(requested.get(key, margins.get(tag(WORD, key), default)), 0, 15840)
                  for key, default in defaults.items()}
        if values["left"] + values["right"] + values["gutter"] >= width or values["top"] + values["bottom"] >= height:
            raise ValueError("Page margins leave no content area")
        for key, value in values.items():
            margins.set(tag(WORD, key), str(value))

    if "columns" in operation:
        columns = section.find(tag(WORD, "cols"))
        if columns is None or len(columns):
            raise ValueError("Document has custom or missing column definitions")
        columns.set(tag(WORD, "num"), str(bounded_integer(operation["columns"], 1, 12)))
        if "columnGapTwips" in operation:
            columns.set(tag(WORD, "space"), str(bounded_integer(operation["columnGapTwips"], 0, 14400)))


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
        elif op in {"docx.set_page_size", "docx.set_page_layout"}:
            update_word_page_layout(body, operation)
        else:
            raise ValueError("Unsupported Word operation")
    write_package(package, {main_part: document}, output, "docx")


CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
SUPPORTED_CHARTS = {"areaChart", "barChart", "doughnutChart", "lineChart", "pieChart", "scatterChart"}


def chart_series(root):
    plot = root.find(".//" + tag(CHART, "plotArea"))
    if plot is None:
        raise ValueError("Chart has no plot area")
    values = []
    for child in plot:
        if not isinstance(child.tag, str):
            continue
        series = child.findall(tag(CHART, "ser"))
        if series and XML.QName(child).localname not in SUPPORTED_CHARTS:
            raise ValueError("Chart series type is unsupported")
        values.extend(series)
    return values


def update_chart_title_and_legend(root, operation):
    chart = root.find(tag(CHART, "chart"))
    if "title" in operation:
        title_text = operation["title"]
        if not isinstance(title_text, str) or len(title_text) > 2000:
            raise ValueError("Invalid chart title")
        title = chart.find(tag(CHART, "title"))
        if title is None:
            title = XML.Element(tag(CHART, "title"))
            chart.insert(0, title)
        title_tx = title.find(tag(CHART, "tx"))
        if title_tx is None:
            title_tx = XML.Element(tag(CHART, "tx"))
            title.insert(0, title_tx)
        if title_tx.find(tag(CHART, "strRef")) is not None:
            raise ValueError("The chart title is linked to worksheet data")
        rich = title_tx.find(tag(CHART, "rich"))
        if rich is None:
            rich = XML.SubElement(title_tx, tag(CHART, "rich"))
            XML.SubElement(rich, tag(DRAWING, "bodyPr"))
            XML.SubElement(rich, tag(DRAWING, "lstStyle"))
            para = XML.SubElement(rich, tag(DRAWING, "p"))
            run = XML.SubElement(para, tag(DRAWING, "r"))
            XML.SubElement(run, tag(DRAWING, "t"))
        texts = list(rich.iter(tag(DRAWING, "t")))
        if len(texts) != 1:
            raise ValueError("Chart title uses mixed formatting")
        texts[0].text = title_text
    if "legendPosition" in operation:
        position = operation["legendPosition"]
        if position not in {"b", "l", "r", "t", "tr", None}:
            raise ValueError("Invalid chart legend position")
        legend = chart.find(tag(CHART, "legend"))
        if position is None:
            if legend is not None:
                chart.remove(legend)
        else:
            if legend is None:
                legend = XML.Element(tag(CHART, "legend"))
                chart.insert(chart.index(chart.find(tag(CHART, "plotArea"))) + 1, legend)
            legend_position = legend.find(tag(CHART, "legendPos"))
            if legend_position is None:
                legend_position = XML.Element(tag(CHART, "legendPos"))
                legend.insert(0, legend_position)
            legend_position.set("val", position)


def chart_value_cache(series):
    refs = [ref for key in ("val", "yVal")
            for ref in series.findall("./" + tag(CHART, key) + "/" + tag(CHART, "numRef"))]
    if len(refs) != 1:
        raise ValueError("Expected one numeric worksheet-backed series")
    ref = refs[0]
    cache = ref.find(tag(CHART, "numCache"))
    if cache is None:
        cache = XML.SubElement(ref, tag(CHART, "numCache"))
    return ref.findtext(tag(CHART, "f")), cache


def chart_cell_updates(package, formula, values):
    if not isinstance(formula, str) or "!" not in formula:
        raise ValueError("Chart series has no local range")
    sheet_name, a1 = formula.rsplit("!", 1)
    if sheet_name.startswith("'") and sheet_name.endswith("'"):
        sheet_name = sheet_name[1:-1].replace("''", "'")
    sheet = next((item for item in workbook_sheets(package) if item["name"] == sheet_name), None)
    if sheet is None:
        raise ValueError("Chart series references an external or unknown worksheet")
    bounds = a1.replace("$", "").split(":")
    first_row, first_col = cell_coordinates(bounds[0])
    last_row, last_col = cell_coordinates(bounds[-1])
    if len(bounds) > 2 or first_col != last_col or last_row - first_row + 1 != len(values):
        raise ValueError("Chart series values must fit its existing vertical worksheet range")
    column = CELL_ADDRESS.fullmatch(bounds[0]).group(1)
    return [{"op": "xlsx.set_cell", "sheetPart": sheet["part"],
             "address": f"{column}{row}", "value": value}
            for row, value in enumerate(values, start=first_row)]


def update_chart_values(package, fmt, chart_part, series, operation, replacements):
    formula, cache = chart_value_cache(series)
    values = operation["values"]
    if not isinstance(values, list) or not 1 <= len(values) <= 1000 or any(
            type(value) not in (float, int) or not math.isfinite(value) for value in values):
        raise ValueError("Chart values must be finite numbers")
    if fmt == "xlsx":
        for change in chart_cell_updates(package, formula, values):
            update_workbook_cell(package, change, replacements)
    else:
        relations = package_relationships(package, chart_part)
        embed = [part for kind, part in relations.values()
                 if kind.endswith("/package") and re.fullmatch(r"ppt/embeddings/[^/]+\.xlsx", part)]
        if len(embed) != 1:
            raise ValueError("Expected one embedded workbook for the chart")
        workbook = replacements.get(embed[0])
        if workbook is None:
            workbook = package.read(embed[0])
        with zipfile.ZipFile(io.BytesIO(workbook)) as embedded:
            validate_package(embedded, "xlsx")
            output = io.BytesIO()
            edit_workbook(embedded, chart_cell_updates(embedded, formula, values), output)
            replacements[embed[0]] = output.getvalue()
    for entry in list(cache):
        if entry.tag in (tag(CHART, "ptCount"), tag(CHART, "pt")):
            cache.remove(entry)
    ext = cache.find(tag(CHART, "extLst"))
    end = cache.index(ext) if ext is not None else len(cache)
    cache.insert(end, XML.Element(tag(CHART, "ptCount"), val=str(len(values))))
    for index, value in enumerate(values):
        point = XML.Element(tag(CHART, "pt"), idx=str(index))
        XML.SubElement(point, tag(CHART, "v")).text = str(value)
        cache.insert(end + index + 1, point)


def add_chart_series(package, fmt, chart_part, series, all_series, operation, replacements):
    template = deepcopy(series)
    siblings = series.getparent().findall(tag(CHART, "ser"))
    all_indices = [bounded_integer(item.find(tag(CHART, "idx")).get("val"), 0, 65535) for item in all_series]
    new_index = max(all_indices) + 1
    if len(siblings) >= 255 or new_index > 65535:
        raise ValueError("Chart series limit exceeded")
    template.find(tag(CHART, "idx")).set("val", str(new_index))
    template.find(tag(CHART, "order")).set("val", str(new_index))
    for existing in template.findall(tag(CHART, "tx")):
        template.remove(existing)
    name = operation["name"]
    if not isinstance(name, str) or len(name) > 255:
        raise ValueError("Invalid chart series name")
    title = XML.Element(tag(CHART, "tx"))
    XML.SubElement(title, tag(CHART, "v")).text = name
    template.insert(2, title)
    for local_name in ("dPt", "dLbls", "trendline", "errBars"):
        for node in template.findall(tag(CHART, local_name)):
            template.remove(node)
    reference = template.find("./" + tag(CHART, "val") + "/" + tag(CHART, "numRef"))
    if reference is None:
        raise ValueError("The chart must use worksheet-backed series values")
    if reference.findtext(tag(CHART, "f")) == operation["rangeFormula"]:
        raise ValueError("New series must use a distinct worksheet range")
    reference.find(tag(CHART, "f")).text = operation["rangeFormula"]
    update_chart_values(package, fmt, chart_part, template, operation, replacements)
    parent = series.getparent()
    parent.insert(parent.index(siblings[-1]) + 1, template)


def edit_chart(package, fmt, operation, replacements):
    chart_part = operation["chartPart"]
    prefix = "xl" if fmt == "xlsx" else "ppt"
    if not re.fullmatch(prefix + r"/charts/[^/]+\.xml", chart_part):
        raise ValueError("Invalid chart part")
    root = replacements.get(chart_part)
    if root is None:
        root = parse_xml(package.read(chart_part))
    all_series = chart_series(root)
    op = operation["op"]
    changes_cells = False
    if op == "chart.update_title_and_legend":
        update_chart_title_and_legend(root, operation)
    else:
        selected = [series for series in all_series if series.find(tag(CHART, "idx")).get("val") == str(operation["seriesIndex"])]
        if len(selected) != 1:
            raise ValueError("Expected a unique chart series index")
        series = selected[0]
        if op == "chart.add_or_remove_series":
            mode = operation["mode"]
            if mode == "remove":
                if len(series.getparent().findall(tag(CHART, "ser"))) <= 1:
                    raise ValueError("Cannot remove the final series of a plot")
                series.getparent().remove(series)
            elif mode == "add":
                add_chart_series(package, fmt, chart_part, series, all_series, operation, replacements)
                changes_cells = True
            else:
                raise ValueError("Unknown series operation")
        elif op == "chart.update_series_data":
            update_chart_values(package, fmt, chart_part, series, operation, replacements)
            changes_cells = True
        elif op == "chart.update_series_style":
            rgb = operation["color"].removeprefix("#")
            if not re.fullmatch(r"[0-9a-fA-F]{6}", rgb):
                raise ValueError("Invalid chart color")
            properties = series.find(tag(CHART, "spPr"))
            if properties is None:
                properties = XML.Element(tag(CHART, "spPr"))
                title = series.find(tag(CHART, "tx"))
                series.insert(series.index(title) + 1 if title is not None else 2, properties)
            if XML.QName(series.getparent()).localname in {"lineChart", "scatterChart"}:
                line = properties.find(tag(DRAWING, "ln"))
                if line is None:
                    line = XML.SubElement(properties, tag(DRAWING, "ln"))
                properties = line
            for child in list(properties):
                if isinstance(child.tag, str) and XML.QName(child).localname in {
                    "noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"
                }:
                    properties.remove(child)
            fill = XML.Element(tag(DRAWING, "solidFill"))
            XML.SubElement(fill, tag(DRAWING, "srgbClr"), val=rgb.upper())
            properties.insert(0, fill)
        else:
            raise ValueError("Unsupported chart operation")
    replacements[chart_part] = root
    return fmt == "xlsx" and changes_cells


DIAGRAM_DRAWING = "http://schemas.microsoft.com/office/drawing/2008/diagram"


def package_relationships(package, source_name):
    parent = PurePosixPath(source_name).parent
    name = parent / "_rels" / (PurePosixPath(source_name).name + ".rels")
    if str(name) not in package.namelist():
        return {}
    root = parse_xml(package.read(str(name)))
    return {relation.attrib["Id"]: (relation.attrib["Type"], resolve_relationship(str(parent), relation.attrib["Target"]))
            for relation in root if isinstance(relation.tag, str) and relation.get("TargetMode") != "External"}


def edit_smartart_text(package, operation, slide_root, replacements):
    slide_part = operation["slidePart"]
    data_part = operation["dataPart"]
    model_id = operation["nodeId"]
    text = operation["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > 2000 or "\r" in text or "\n" in text:
        raise ValueError("SmartArt requires a nonempty, single-line label")
    relationships = package_relationships(package, slide_part)
    data_ids = [rel_id for rel_id, (kind, part) in relationships.items()
                if kind.endswith("/diagramData") and part == data_part]
    if len(data_ids) != 1 or not any(element.get(tag(OFFICE_REL, "dm")) == data_ids[0]
                                      for element in slide_root.iter(tag(DIAGRAM, "relIds"))):
        raise ValueError("The slide does not reference this SmartArt data model")
    data = replacements.get(data_part)
    if data is None:
        data = parse_xml(package.read(data_part))
    drawing_ids = [element.get("relId") for element in data.iter(tag(DIAGRAM_DRAWING, "dataModelExt"))]
    if len(drawing_ids) != 1:
        raise ValueError("SmartArt drawing cache relationship is missing or ambiguous")
    drawing_type, drawing_part = relationships.get(drawing_ids[0], ("", ""))
    if not drawing_type.endswith("/diagramDrawing"):
        raise ValueError("SmartArt drawing cache is missing")
    drawing = replacements.get(drawing_part)
    if drawing is None:
        drawing = parse_xml(package.read(drawing_part))
    points = list(data.iter(tag(DIAGRAM, "pt")))
    logical_points = [point for point in points if point.get("modelId") == model_id and point.get("type") in (None, "node")]
    if len(logical_points) != 1:
        raise ValueError("Expected a unique editable SmartArt node")
    label = list(logical_points[0].iter(tag(DRAWING, "t")))
    if len(label) != 1:
        raise ValueError("SmartArt node has mixed formatting or no editable label")
    display_ids = {point.get("modelId") for point in points if point.get("type") == "pres"
                   and any(child.get("presAssocID") == model_id for child in point.findall(tag(DIAGRAM, "prSet")))}
    matching_shapes = [shape for shape in drawing.iter(tag(DIAGRAM_DRAWING, "sp")) if shape.get("modelId") in display_ids]
    display_labels = [list(shape.iter(tag(DRAWING, "t"))) for shape in matching_shapes]
    display_labels = [labels for labels in display_labels if labels]
    if not display_labels or any(len(labels) != 1 or labels[0].text != label[0].text for labels in display_labels):
        raise ValueError("SmartArt data and drawing text cannot be synchronized safely")
    label[0].text = text
    for labels in display_labels:
        labels[0].text = text
    replacements[data_part] = data
    replacements[drawing_part] = drawing


def presentation_slides(package, root):
    relationships = package_relationships(package, MAIN_PART["pptx"])
    slides = root.find(tag(PRESENTATION, "sldIdLst"))
    result = []
    for slide in slides if slides is not None else ():
        rel_type, part = relationships.get(slide.get(tag(OFFICE_REL, "id")), ("", ""))
        if not rel_type.endswith("/slide"):
            raise ValueError("Presentation references a missing slide")
        result.append({"id": slide.get("id"), "part": part})
    if len({slide["id"] for slide in result}) != len(result):
        raise ValueError("Duplicate slide ID")
    return result


def presentation_layer(package, part, next_relation, depth=0):
    if depth > 2:
        raise ValueError("Invalid presentation layer relationship")
    root = parse_xml(package.read(part))
    common = root.find(tag(PRESENTATION, "cSld"))
    tree = common.find(tag(PRESENTATION, "spTree"))
    layers = []
    if next_relation:
        relations = [target for kind, target in package_relationships(package, part).values()
                     if kind.endswith("/" + next_relation)]
        if len(relations) > 1:
            raise ValueError("Presentation layer relationship is ambiguous")
        if relations:
            layers = presentation_layer(package, relations[0], "slideMaster" if depth == 0 else None, depth + 1)
    kind = ("slide", "layout", "master")[depth]
    if root.get("showMasterSp") in ("0", "false"):
        layers = [layer for layer in layers if layer["kind"] != "master"]
    return layers + [{"kind": kind, "part": part,
                      "hasBackground": common.find(tag(PRESENTATION, "bg")) is not None,
                      "shapes": pptx_shape_order(tree)}]


def edit_presentation(package, operations, output):
    replacements = {}
    for operation in operations:
        if operation["op"].startswith("chart."):
            edit_chart(package, "pptx", operation, replacements)
            continue
        slide = operation["slidePart"]
        if not re.fullmatch(r"ppt/slides/[^/]+\.xml", slide):
            raise ValueError("Invalid slide part")
        root = replacements.get(slide)
        if root is None:
            root = parse_xml(package.read(slide))
        if operation["op"] == "pptx.smartart.update_node_text":
            edit_smartart_text(package, operation, root, replacements)
            continue
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
            if text is None:
                raise ValueError("Shape has no editable text")
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


def create_chart_document(source, fmt, operation, destination):
    generated_source = io.BytesIO()
    if fmt == "xlsx":
        part = create_sheet_chart(source, operation, generated_source)
    else:
        part = create_slide_chart(source, operation, generated_source)
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(generated_source) as generated:
        old_names = checked_members(original)
        new_names = checked_members(generated) - old_names
        additions = {name: generated.read(name) for name in new_names}
        old_part = parse_xml(original.read(part))
        new_part = parse_xml(generated.read(part))
        if fmt == "xlsx":
            old_drawing = old_part.find(tag(SPREADSHEET, "drawing"))
            drawing = new_part.find(tag(SPREADSHEET, "drawing"))
            if old_drawing is not None or drawing is None:
                raise ValueError("Chart creation requires a worksheet without an existing drawing")
            trailing = {"legacyDrawing", "legacyDrawingHF", "picture", "oleObjects", "controls",
                        "webPublishItems", "tableParts", "extLst"}
            offset = next((index for index, node in enumerate(old_part)
                           if isinstance(node.tag, str) and XML.QName(node).localname in trailing), len(old_part))
            old_part.insert(offset, drawing)
            relation_id = drawing.attrib[tag(OFFICE_REL, "id")]
        else:
            old_tree = old_part.find(".//" + tag(PRESENTATION, "spTree"))
            new_tree = new_part.find(".//" + tag(PRESENTATION, "spTree"))
            known = {entry["id"] for entry in pptx_shape_order(old_tree)}
            added = [shape for shape in new_tree.findall(tag(PRESENTATION, "graphicFrame"))
                     if shape.find("./*/" + tag(PRESENTATION, "cNvPr")).get("id") not in known]
            if len(added) != 1:
                raise ValueError("Cannot isolate the new chart from the original slide")
            extension = old_tree.find(tag(PRESENTATION, "extLst"))
            old_tree.insert(old_tree.index(extension) if extension is not None else len(old_tree), added[0])
            chart = added[0].find(".//" + tag(CHART, "chart"))
            relation_id = chart.attrib[tag(OFFICE_REL, "id")]

        name = PurePosixPath(part)
        relation_part = str(name.parent / "_rels" / (name.name + ".rels"))
        new_rels = parse_xml(generated.read(relation_part))
        relation = next(element for element in new_rels if element.get("Id") == relation_id)
        related = resolve_relationship(str(name.parent), relation.attrib["Target"])
        if related not in new_names:
            raise ValueError("The new chart references an existing package part")
        if relation_part in old_names:
            merged_rels = parse_xml(original.read(relation_part))
        else:
            merged_rels = XML.Element(tag(RELATIONSHIPS, "Relationships"), nsmap={None: RELATIONSHIPS})
            additions.pop(relation_part, None)
        if any(element.get("Id") == relation_id for element in merged_rels):
            raise ValueError("The new chart relationship would replace an existing relationship")
        merged_rels.append(relation)

        type_part = "[Content_Types].xml"
        content_types = parse_xml(original.read(type_part))
        new_types = parse_xml(generated.read(type_part))
        extensions = {PurePosixPath(name).suffix.lstrip(".") for name in new_names}
        original_extensions = {element.get("Extension") for element in content_types}
        for element in list(new_types):
            if element.tag == tag(CONTENT_TYPES, "Override") and element.attrib["PartName"].lstrip("/") in new_names:
                content_types.append(element)
            if element.tag == tag(CONTENT_TYPES, "Default") and element.get("Extension") in extensions - original_extensions:
                content_types.append(element)
        replacements = {part: old_part, type_part: content_types}
        if relation_part in old_names:
            replacements[relation_part] = merged_rels
        else:
            additions[relation_part] = XML.tostring(merged_rels, encoding="UTF-8", xml_declaration=True)
        write_package(original, replacements, destination, fmt, additions=additions)


def create_sheet_chart(source, operation, destination):
    from openpyxl import load_workbook
    from openpyxl.chart import AreaChart, BarChart, DoughnutChart, LineChart, PieChart, ScatterChart, Reference, Series

    kind = operation["kind"]
    classes = {"bar": BarChart, "column": BarChart, "line": LineChart, "pie": PieChart,
               "doughnut": DoughnutChart, "area": AreaChart, "scatter": ScatterChart, "combo": BarChart}
    chart = classes[kind]()
    book = load_workbook(source)
    worksheet = book[operation["sheetName"]]
    if kind in {"bar", "column", "combo"}:
        chart.type = "bar" if kind == "bar" else "col"
    chart.title = operation.get("title", "")[:2000]
    first, last = operation["dataRange"].split(":")
    min_row, min_col = cell_coordinates(first)
    max_row, max_col = cell_coordinates(last)
    category_column = bounded_integer(operation["categoryColumn"], 1, 16384)
    if not 1 <= max_row - min_row <= 1000 or not 0 <= max_col - min_col < 16:
        raise ValueError("Chart source exceeds the allowed table range")
    categories = Reference(worksheet, min_col=category_column, min_row=min_row + 1, max_row=max_row)
    if kind == "scatter":
        for column in range(min_col, max_col + 1):
            values = Reference(worksheet, min_col=column, min_row=min_row, max_row=max_row)
            chart.series.append(Series(values, categories, title_from_data=True))
    elif kind == "combo":
        if max_col != min_col + 1:
            raise ValueError("A combination chart requires exactly two value columns")
        chart.add_data(Reference(worksheet, min_col=min_col, min_row=min_row, max_row=max_row), titles_from_data=True)
        chart.set_categories(categories)
        line = LineChart()
        line.add_data(Reference(worksheet, min_col=max_col, min_row=min_row, max_row=max_row), titles_from_data=True)
        line.set_categories(categories)
        line.y_axis.axId = 200
        chart.y_axis.crosses = "max"
        chart += line
    else:
        chart.add_data(Reference(worksheet, min_col=min_col, max_col=max_col, min_row=min_row, max_row=max_row),
                       titles_from_data=True)
        chart.set_categories(categories)
    anchor = operation["anchor"]
    cell_coordinates(anchor)
    worksheet.add_chart(chart, anchor)
    with zipfile.ZipFile(source) as package:
        part = next(sheet["part"] for sheet in workbook_sheets(package) if sheet["name"] == worksheet.title)
    book.save(destination)
    return part


def add_secondary_line_axis(chart):
    plot_area = chart._chartSpace.find(".//" + tag(CHART, "plotArea"))
    bar = plot_area.find(tag(CHART, "barChart"))
    category_axis = plot_area.find(tag(CHART, "catAx"))
    value_axis = plot_area.find(tag(CHART, "valAx"))
    series = bar.findall(tag(CHART, "ser"))
    if len(series) != 2 or category_axis is None or value_axis is None:
        raise ValueError("A combination chart requires two series and a category axis")
    existing_ids = {node.get("val") for node in plot_area.iter(tag(CHART, "axId"))}
    secondary_id = next(str(index) for index in range(200, 300) if str(index) not in existing_ids)
    category_id = category_axis.find(tag(CHART, "axId")).get("val")
    line = XML.Element(tag(CHART, "lineChart"))
    XML.SubElement(line, tag(CHART, "grouping"), val="standard")
    secondary_series = series[1]
    for name in ("invertIfNegative", "pictureOptions", "shape"):
        element = secondary_series.find(tag(CHART, name))
        if element is not None:
            secondary_series.remove(element)
    line.append(secondary_series)
    XML.SubElement(line, tag(CHART, "axId"), val=category_id)
    XML.SubElement(line, tag(CHART, "axId"), val=secondary_id)
    plot_area.insert(plot_area.index(bar) + 1, line)

    new_axis = deepcopy(value_axis)
    new_axis.find(tag(CHART, "axId")).set("val", secondary_id)
    new_axis.find(tag(CHART, "axPos")).set("val", "r")
    new_axis.find(tag(CHART, "crossAx")).set("val", category_id)
    crosses = new_axis.find(tag(CHART, "crosses"))
    if crosses is not None:
        crosses.set("val", "max")
    plot_area.insert(plot_area.index(value_axis) + 1, new_axis)


def create_slide_chart(source, operation, destination):
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData, XyChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.util import Pt

    kind = operation["kind"]
    types = {"bar": XL_CHART_TYPE.BAR_CLUSTERED, "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
             "line": XL_CHART_TYPE.LINE, "pie": XL_CHART_TYPE.PIE, "doughnut": XL_CHART_TYPE.DOUGHNUT,
             "area": XL_CHART_TYPE.AREA, "scatter": XL_CHART_TYPE.XY_SCATTER,
             "combo": XL_CHART_TYPE.COLUMN_CLUSTERED}
    presentation = Presentation(source)
    index = bounded_integer(operation["pageIndex"], 0, len(presentation.slides) - 1)
    slide = presentation.slides[index]
    categories = operation["categories"]
    requested_series = operation["series"]
    if not isinstance(categories, list) or not 1 <= len(categories) <= 1000 or \
            not isinstance(requested_series, list) or not 1 <= len(requested_series) <= 16:
        raise ValueError("Chart source exceeds the allowed table range")
    data = XyChartData() if kind == "scatter" else CategoryChartData()
    if kind != "scatter":
        data.categories = [str(value)[:2000] for value in categories]
    for requested in requested_series:
        values = requested["values"]
        if not isinstance(values, list) or len(values) != len(categories) or any(
                type(value) not in (float, int) or not math.isfinite(value) for value in values):
            raise ValueError("Chart series must match the category count and use finite numbers")
        title = requested["name"][:255]
        if kind == "scatter":
            series = data.add_series(title)
            for category, value in zip(categories, values):
                series.add_data_point(float(category), value)
        else:
            data.add_series(title, values)
    position = operation.get("boundsPt", [72, 72, 360, 216])
    if len(position) != 4 or any(type(value) not in (int, float) or not 0 <= value <= 14400 for value in position) \
            or min(position[2:]) <= 0:
        raise ValueError("Invalid chart geometry")
    chart = slide.shapes.add_chart(types[kind], *(Pt(value) for value in position), data).chart
    if kind == "combo":
        add_secondary_line_axis(chart)
    if operation.get("title"):
        chart.has_title = True
        chart.chart_title.text_frame.text = operation["title"][:2000]
    presentation.save(destination)
    return str(slide.part.partname).lstrip("/")


def edit_office_document(package, fmt, operations, output):
    editors = {"xlsx": edit_workbook, "docx": edit_word, "pptx": edit_presentation}
    editor = editors[fmt]
    if not any(operation["op"] == "chart.create" for operation in operations):
        editor(package, operations, output)
        return
    document = io.BytesIO()
    write_package(package, {}, document, fmt)
    pending = []
    for operation in operations:
        if operation["op"] != "chart.create":
            pending.append(operation)
            continue
        if pending:
            edited = io.BytesIO()
            with zipfile.ZipFile(document) as current:
                editor(current, pending, edited)
            document = edited
            pending.clear()
        chart_output = io.BytesIO()
        document.seek(0)
        create_chart_document(document, fmt, operation, chart_output)
        document = chart_output
    if pending:
        with zipfile.ZipFile(document) as current:
            editor(current, pending, output)
    else:
        output.write_bytes(document.getvalue())


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


def _keep_shape_in_tree(tree, target_id):
    matched = False
    for shape in list(tree):
        properties = shape.find("./*/" + tag(PRESENTATION, "cNvPr"))
        if properties is None:
            continue
        matches = properties.get("id") == target_id
        if not matches and shape.tag == tag(PRESENTATION, "grpSp"):
            matches = _keep_shape_in_tree(shape, target_id)
        if matches:
            if matched:
                raise ValueError("Duplicate presentation shape ID")
            matched = True
        else:
            tree.remove(shape)
    return matched


def solid_slide_background(slide_root, rgb):
    slide_root.set("showMasterSp", "0")
    common = slide_root.find(tag(PRESENTATION, "cSld"))
    old_background = common.find(tag(PRESENTATION, "bg"))
    if old_background is not None:
        common.remove(old_background)
    background = XML.Element(tag(PRESENTATION, "bg"))
    props = XML.SubElement(background, tag(PRESENTATION, "bgPr"))
    fill = XML.SubElement(props, tag(DRAWING, "solidFill"))
    XML.SubElement(fill, tag(DRAWING, "srgbClr"), val=rgb)
    XML.SubElement(props, tag(DRAWING, "effectLst"))
    common.insert(0, background)


def export_presentation_image(package, replacements, name, dimensions):
    root = Path.cwd()
    slide = root / (name + ".pptx")
    write_package(package, replacements, slide, "pptx")
    page_width, page_height = dimensions
    scale = 1280 / max(page_width, page_height)
    options = json.dumps({
        "PageNumber": {"type": "long", "value": "1"},
        "Translucent": {"type": "boolean", "value": "false"},
        "PixelWidth": {"type": "long", "value": str(max(1, round(page_width * scale)))},
        "PixelHeight": {"type": "long", "value": str(max(1, round(page_height * scale)))},
    }, separators=(",", ":"))
    subprocess.run(["libreoffice", "-env:UserInstallation=" + (root / "office-profile").as_uri(),
                    "--headless", "--convert-to", "png:impress_png_Export:" + options,
                    "--outdir", str(root), str(slide)], check=True)
    return slide.with_suffix(".png")


def alpha_from_black_white(black_path, white_path, output, dimensions):
    from PIL import Image, ImageChops, ImageMath, PngImagePlugin

    with Image.open(black_path) as black, Image.open(white_path) as white:
        if black.size != white.size:
            raise ValueError("Sprite geometry differs between matte renders")
        image_size(black.size)
        black_channels = black.convert("RGB").split()
        white_channels = white.convert("RGB").split()
    deltas = [ImageChops.subtract(light, dark) for light, dark in zip(white_channels, black_channels)]
    delta = ImageChops.lighter(deltas[0], ImageChops.lighter(deltas[1], deltas[2]))
    alpha = ImageChops.invert(delta)
    if alpha.getextrema() == (255, 255) or alpha.getbbox() is None:
        raise ValueError("LibreOffice did not produce an isolatable sprite")

    def straight(channel):
        return ImageMath.lambda_eval(
            lambda operands: (operands["pixel"] * 255 / (operands["alpha"] + (operands["alpha"] == 0))),
            pixel=channel, alpha=alpha,
        ).convert("L")

    width, height = alpha.size
    page_width, page_height = (coordinate / 12700 for coordinate in dimensions)
    left, top, right, bottom = alpha.getbbox()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("inkBoundsPt", json.dumps({
        "x": left * page_width / width,
        "y": top * page_height / height,
        "width": (right - left) * page_width / width,
        "height": (bottom - top) * page_height / height,
    }))
    Image.merge("RGBA", (*[straight(channel) for channel in black_channels], alpha)).save(
        output, format="PNG", pnginfo=metadata
    )


def render_presentation_layer(package, request, output):
    presentation_part = MAIN_PART["pptx"]
    presentation = parse_xml(package.read(presentation_part))
    slides = presentation_slides(package, presentation)
    index = bounded_integer(request.get("pageIndex", 0), 0, len(slides) - 1)
    slide_part = slides[index]["part"]
    size = presentation.find(tag(PRESENTATION, "sldSz"))
    if size is None:
        raise ValueError("Missing presentation dimensions")
    dimensions = (bounded_integer(size.get("cx"), 1, 182880000), bounded_integer(size.get("cy"), 1, 182880000))
    slide_ids = presentation.find(tag(PRESENTATION, "sldIdLst"))
    for offset, slide_id in enumerate(list(slide_ids)):
        if offset != index:
            slide_ids.remove(slide_id)

    slide = parse_xml(package.read(slide_part))
    tree = slide.find(".//" + tag(PRESENTATION, "spTree"))
    replacements = {presentation_part: presentation, slide_part: slide}
    variant = request.get("variant")
    if variant != "sprite":
        if variant == "background":
            _keep_shape_in_tree(tree, None)
        export_presentation_image(package, replacements, "slide", dimensions).replace(output)
        return
    target_id = str(request["shapeId"])
    if not _keep_shape_in_tree(tree, target_id):
        raise ValueError("Presentation shape was not found")
    solid_slide_background(slide, "000000")
    black = export_presentation_image(package, replacements, "sprite-black", dimensions)
    solid_slide_background(slide, "FFFFFF")
    white = export_presentation_image(package, replacements, "sprite-white", dimensions)
    alpha_from_black_white(black, white, output, dimensions)


def render_office(source, output, request):
    fmt = request["format"]
    staging = Path.cwd() / ("source." + fmt)
    staging.write_bytes(source.read_bytes())
    subprocess.run(["libreoffice", "-env:UserInstallation=" + (Path.cwd() / "office-profile").as_uri(),
                    "--headless", "--convert-to", "pdf", "--outdir", str(Path.cwd()), str(staging)],
                   check=True)
    pdf = staging.with_suffix(".pdf")
    if request["action"] == "export" and request["targetFormat"] == "pdf":
        pdf.replace(output)
    else:
        process_pdf({**request, "format": "pdf", "action": "render"}, pdf, output)


def export_delimited_workbook(source, output):
    from openpyxl import load_workbook
    with source.open("rb") as stream:
        workbook = load_workbook(stream, read_only=True, data_only=True)
        try:
            _write_workbook_csv(workbook, output)
        finally:
            workbook.close()


def _write_workbook_csv(workbook, output):
    sheet = workbook.worksheets[0]
    if (sheet.max_row or 0) * (sheet.max_column or 0) > 1_000_000:
        raise ValueError("Worksheet exceeds the CSV export limit")
    with output.open("w", encoding="utf-8", newline="") as destination:
        writer = csv.writer(destination)
        count = 0
        for row in sheet.values:
            count += len(row)
            if count > 1_000_000:
                raise ValueError("Worksheet exceeds the CSV export limit")
            writer.writerow(row)


def export_docx(source, output, target):
    writer = {"md": "gfm", "html": "html5"}[target]
    subprocess.run(["pandoc", "--from", "docx", "--to", writer,
                    "--output", str(output), str(source)], check=True)


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
        if action == "export":
            target = request["targetFormat"]
            if fmt == "xlsx" and target == "csv":
                export_delimited_workbook(source, output)
            elif fmt == "docx" and target in {"md", "html"}:
                export_docx(source, output, target)
            elif target in {"png", "pdf"}:
                if fmt == "pptx" and target == "png":
                    render_presentation_layer(package, request, output)
                else:
                    render_office(source, output, request)
            else:
                raise ValueError("Unsupported document export")
            return None
        if action == "render":
            if fmt == "pptx":
                render_presentation_layer(package, request, output)
            else:
                render_office(source, output, request)
            return None
        if action == "edit":
            edit_office_document(package, fmt, request["operations"], output)
            return None
        if action == "verify":
            return {"ok": True, "issues": [], "metrics": {"packageParts": len(names)}}
        if action == "range" and fmt == "xlsx":
            options = request["range"]
            result = read_workbook_range(package, options)
            if options.get("evaluate") is True and any("formulaStatus" in cell for cell in result["cells"]):
                return evaluate_workbook_range(package, source, options, result)
            return result
        main = parse_xml(package.read(MAIN_PART[fmt]))
        result = {"format": fmt, "packageParts": len(names),
                  "chartParts": sorted(name for name in names if re.fullmatch(r"(xl|ppt)/charts/[^/]+\.xml", name))}
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
            slides = presentation_slides(package, main)
            slide_parts = [slide["part"] for slide in slides]
            diagrams = sorted(name for name in names if re.fullmatch(r"ppt/diagrams/data[^/]+\.xml", name))
            if action == "structure":
                size = main.find(tag(PRESENTATION, "sldSz"))
                dimensions = None if size is None else {
                    "widthPt": int(size.get("cx")) / 12700, "heightPt": int(size.get("cy")) / 12700,
                }
                return {**result, "slides": slides, "slideParts": slide_parts, "slideSize": dimensions,
                        "smartArtParts": diagrams}
            part = request["range"]["part"]
            if part not in slide_parts and part not in diagrams:
                raise ValueError("Unknown slide or SmartArt part")
            root = parse_xml(package.read(part))
            if part in diagrams:
                layout = next((node.get("loTypeId") for node in root.iter(tag(DIAGRAM, "prSet"))
                               if node.get("loTypeId")), None)
                return {**result, "part": part, "layout": layout,
                        "nodes": [{"id": node.get("modelId"), "type": node.get("type"), "text": text_content(node, DRAWING)}
                                  for node in root.iter(tag(DIAGRAM, "pt"))][:1000],
                        "connections": [dict(node.attrib) for node in root.iter(tag(DIAGRAM, "cxn"))][:1000]}
            layers = presentation_layer(package, part, "slideLayout")
            return {**result, "part": part, "shapes": layers[-1]["shapes"], "layers": layers}
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
    except UnsupportedStructuralMutation as error:
        print(str(error), file=sys.stderr)
        sys.exit(3)
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, XML.LxmlError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
