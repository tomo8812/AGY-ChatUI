"""Bounded document processing entry point for DocWorkerSandbox."""

import json
import io
from copy import deepcopy
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
    changes_cells = False
    for operation in operations:
        op = operation["op"]
        if op.startswith("chart."):
            changes_cells |= edit_chart(package, "xlsx", operation, replacements)
            continue
        changes_cells = True
        update_workbook_cell(package, operation, replacements)
    removed = invalidate_calculation(package, replacements) if changes_cells else ()
    write_package(package, replacements, output, "xlsx", removed)


def update_workbook_cell(package, operation, replacements):
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


def write_package(package, replacements, output, fmt, removed=()):
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
    refs = series.findall("./" + tag(CHART, "val") + "/" + tag(CHART, "numRef"))
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
            slides = sorted(name for name in names if re.fullmatch(r"ppt/slides/[^/]+\.xml", name))
            diagrams = sorted(name for name in names if re.fullmatch(r"ppt/diagrams/data[^/]+\.xml", name))
            if action == "structure":
                return {**result, "slideParts": slides, "smartArtParts": diagrams}
            part = request["range"]["part"]
            if part not in slides and part not in diagrams:
                raise ValueError("Unknown slide or SmartArt part")
            root = parse_xml(package.read(part))
            if part in diagrams:
                layout = next((node.get("loTypeId") for node in root.iter(tag(DIAGRAM, "prSet"))
                               if node.get("loTypeId")), None)
                return {**result, "part": part, "layout": layout,
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
