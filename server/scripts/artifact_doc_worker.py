"""Bounded document processing entry point for DocWorkerSandbox."""

import base64
import csv
import hashlib
import json
import io
from copy import copy, deepcopy
import math
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import sys
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit
import uuid
import zipfile

from lxml import etree as XML


CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
MAIN_PART = {"xlsx": "xl/workbook.xml", "docx": "word/document.xml", "pptx": "ppt/presentation.xml"}
MAX_UNCOMPRESSED = 200 * 1024 * 1024


class UnsupportedByFormatError(ValueError):
    """Raised when a valid format-specific operation is structurally unsupported for a given sub-type."""


def find_system_font(bold=False, cjk=False):
    candidates = []
    if cjk:
        candidates.extend([
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc" if bold else "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansJP-Regular.otf",
        ])
    candidates.extend([
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    ])
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    return None


def load_pil_font(size_px=14, bold=False, cjk=False):
    from PIL import ImageFont
    font_path = find_system_font(bold=bold, cjk=cjk)
    if font_path:
        try:
            return ImageFont.truetype(font_path, max(8, int(round(size_px))))
        except OSError:
            pass
    return ImageFont.load_default()


def crop_png_region(output_path, region, page_size_pt=None):
    """Crop an output PNG in-place according to normalized, pixel, or point region coordinates."""
    if not region:
        return
    if not isinstance(region, dict):
        raise ValueError("Render region must be an object")
    unit = region.get("unit", "norm")
    try:
        rx = float(region["x"])
        ry = float(region["y"])
        rw = float(region["width"])
        rh = float(region["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Invalid render region coordinates") from exc
    if not all(math.isfinite(v) for v in (rx, ry, rw, rh)) or rw <= 0 or rh <= 0 or rx < 0 or ry < 0:
        raise ValueError("Invalid render region bounds")
    from PIL import Image
    with Image.open(output_path) as opened:
        img = opened.copy()
    width, height = img.size
    if unit == "norm":
        if rx >= 1.0 or ry >= 1.0 or rx + rw > 1.001 or ry + rh > 1.001:
            raise ValueError("Normalized render region exceeds [0, 1]")
        left = int(math.floor(rx * width))
        top = int(math.floor(ry * height))
        right = int(math.ceil((rx + rw) * width))
        bottom = int(math.ceil((ry + rh) * height))
    elif unit == "px":
        left = int(math.floor(rx))
        top = int(math.floor(ry))
        right = int(math.ceil(rx + rw))
        bottom = int(math.ceil(ry + rh))
    elif unit == "pt":
        if page_size_pt and page_size_pt[0] > 0 and page_size_pt[1] > 0:
            sx = width / float(page_size_pt[0])
            sy = height / float(page_size_pt[1])
        else:
            sx = sy = 96.0 / 72.0
        left = int(math.floor(rx * sx))
        top = int(math.floor(ry * sy))
        right = int(math.ceil((rx + rw) * sx))
        bottom = int(math.ceil((ry + rh) * sy))
    else:
        raise ValueError(f"Unsupported render region unit: {unit}")
    left = max(0, min(width - 1, left))
    top = max(0, min(height - 1, top))
    right = max(left + 1, min(width, right))
    bottom = max(top + 1, min(height, bottom))
    cropped = img.crop((left, top, right, bottom))
    if cropped.size[0] > 8192 or cropped.size[1] > 8192:
        raise ValueError("Cropped image exceeds maximum PNG dimensions")
    cropped.save(output_path, format="PNG")


def compute_image_ssim_and_mae(img_a, img_b):
    """Compute grayscale structural similarity (SSIM) and mean absolute error (0..255) over 8x8 blocks."""
    from PIL import Image
    if img_a.size != img_b.size:
        img_b = img_b.resize(img_a.size, Image.Resampling.BILINEAR)
    # Downsample very large renders for fast deterministic block SSIM while preserving layout structure.
    max_side = 512
    if max(img_a.size) > max_side:
        scale = max_side / float(max(img_a.size))
        target_size = (max(8, int(round(img_a.size[0] * scale))), max(8, int(round(img_a.size[1] * scale))))
        img_a = img_a.resize(target_size, Image.Resampling.BILINEAR)
        img_b = img_b.resize(target_size, Image.Resampling.BILINEAR)
    gray_a = list(img_a.convert("L").tobytes())
    gray_b = list(img_b.convert("L").tobytes())
    w, h = img_a.size
    n = len(gray_a)
    if n == 0:
        return 1.0, 0.0
    mae = sum(abs(a - b) for a, b in zip(gray_a, gray_b)) / float(n)
    c1 = (0.01 * 255.0) ** 2
    c2 = (0.03 * 255.0) ** 2
    block = 8
    ssim_sum = 0.0
    blocks = 0
    for by in range(0, max(1, h - block + 1), block):
        for bx in range(0, max(1, w - block + 1), block):
            bh = min(block, h - by)
            bw = min(block, w - bx)
            vals_a = []
            vals_b = []
            for dy in range(bh):
                row_off = (by + dy) * w + bx
                vals_a.extend(gray_a[row_off:row_off + bw])
                vals_b.extend(gray_b[row_off:row_off + bw])
            m = float(len(vals_a))
            if m == 0:
                continue
            mu_a = sum(vals_a) / m
            mu_b = sum(vals_b) / m
            var_a = sum((v - mu_a) ** 2 for v in vals_a) / m
            var_b = sum((v - mu_b) ** 2 for v in vals_b) / m
            cov = sum((a - mu_a) * (b - mu_b) for a, b in zip(vals_a, vals_b)) / m
            num = (2.0 * mu_a * mu_b + c1) * (2.0 * cov + c2)
            den = (mu_a ** 2 + mu_b ** 2 + c1) * (var_a + var_b + c2)
            ssim_sum += num / den if den else 1.0
            blocks += 1
    return (ssim_sum / blocks if blocks else 1.0), mae


def render_csv_table(request, source, output):
    """Render a CSV/TSV file as a crisp grid table PNG with header shading, borders, and pagination."""
    from PIL import Image, ImageDraw
    filename = request.get("filename", "table.csv")
    delimiter = "\t" if str(filename).lower().endswith(".tsv") else ","
    raw_text = source.read_text(encoding="utf-8", errors="replace").lstrip("\ufeff")
    rows = list(csv.reader(io.StringIO(raw_text), delimiter=delimiter))
    if not rows:
        rows = [["(empty)"]]
    has_non_ascii = any(ord(ch) > 127 for r in rows[:200] for cell in r for ch in cell)
    font_body = load_pil_font(14, bold=False, cjk=has_non_ascii)
    font_header = load_pil_font(14, bold=True, cjk=has_non_ascii)

    rows_per_page = 40
    header = rows[0]
    data_rows = rows[1:]
    page_index = bounded_integer(request.get("pageIndex", 0), 0, max(0, (max(1, len(data_rows)) - 1) // rows_per_page))
    page_slice = data_rows[page_index * rows_per_page:(page_index + 1) * rows_per_page]
    visible_rows = [header] + page_slice
    col_count = max(1, min(30, max(len(r) for r in visible_rows)))

    measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    pad_x, pad_y = 12, 8
    row_height = 32
    col_widths = []
    for c in range(col_count):
        max_w = 64
        for r_idx, row in enumerate(visible_rows):
            text = (row[c] if c < len(row) else "").replace("\r", " ").replace("\n", " ")[:120]
            fnt = font_header if r_idx == 0 else font_body
            bbox = measure.textbbox((0, 0), text, font=fnt)
            max_w = max(max_w, min(320, int(bbox[2] - bbox[0]) + pad_x * 2))
        col_widths.append(max_w)

    margin = 20
    table_w = sum(col_widths)
    table_h = len(visible_rows) * row_height
    img_w = min(4096, table_w + margin * 2)
    img_h = min(4096, table_h + margin * 2 + 24)
    img = Image.new("RGB", (img_w, img_h), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    for r_idx, row in enumerate(visible_rows):
        y0 = margin + r_idx * row_height
        y1 = y0 + row_height
        if y1 > img_h - margin:
            break
        bg = (232, 240, 252) if r_idx == 0 else ((249, 250, 252) if r_idx % 2 == 0 else (255, 255, 255))
        draw.rectangle((margin, y0, min(img_w - margin, margin + table_w), y1), fill=bg)
        x = margin
        fnt = font_header if r_idx == 0 else font_body
        for c in range(col_count):
            cw = col_widths[c]
            if x >= img_w - margin:
                break
            draw.rectangle((x, y0, min(img_w - margin, x + cw), y1), outline=(209, 213, 219), width=1)
            cell_text = (row[c] if c < len(row) else "").replace("\r", " ").replace("\n", " ")[:120]
            # Truncate cleanly to fit column width
            while cell_text and measure.textbbox((0, 0), cell_text, font=fnt)[2] > cw - pad_x * 2:
                cell_text = cell_text[:-2] + "…" if len(cell_text) > 2 else ""
            draw.text((x + pad_x, y0 + pad_y), cell_text, fill=(17, 24, 39), font=fnt)
            x += cw

    footer = f"{filename} — page {page_index + 1} ({len(rows)} rows x {col_count} cols)"
    draw.text((margin, min(img_h - 20, margin + table_h + 6)), footer, fill=(107, 114, 128), font=load_pil_font(11))
    img.save(output, format="PNG")
    crop_png_region(output, request.get("region"))


def export_markdown(source, output, target):
    """Export Markdown to DOCX (via pandoc with python-docx fallback) or PDF (via pandoc + LibreOffice)."""
    target = target.lower()
    if target not in {"docx", "pdf"}:
        raise ValueError(f"Unsupported markdown export target: {target}")
    docx_path = output if target == "docx" else (Path.cwd() / "markdown-export.docx")
    if shutil.which("pandoc"):
        subprocess.run(
            ["pandoc", "--from", "gfm", "--to", "docx", "--output", str(docx_path), str(source)],
            check=True,
        )
    else:
        from docx import Document
        doc = Document()
        for line in source.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^(#{1,6})\s+(.+)$", line)
            if m:
                doc.add_heading(m.group(2).strip(), level=min(9, len(m.group(1))))
            elif line.strip():
                doc.add_paragraph(line)
        doc.save(docx_path)
    if target == "pdf":
        render_office(docx_path, output, {"format": "docx", "action": "export", "targetFormat": "pdf"})



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
    relations = load_edit_part(package, replacements, {}, rel_name)
    for relation in list(relations):
        if relation.get("Type", "").endswith("/calcChain") and relation.get("TargetMode") != "External":
            removed.add(resolve_relationship("xl", relation.attrib["Target"]))
            relations.remove(relation)
    if removed:
        replacements[rel_name] = relations
        types = load_edit_part(package, replacements, {}, "[Content_Types].xml")
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


SHEET_CHILDREN = (
    "sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr",
    "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate",
    "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks",
    "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties",
    "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "picture",
    "oleObjects", "controls", "webPublishItems", "tableParts", "extLst",
)


def sheet_node(sheet, name, **attributes):
    later = SHEET_CHILDREN[SHEET_CHILDREN.index(name) + 1:]
    return xml_child(sheet, SPREADSHEET, name, later, **attributes)


def bounded_sheet_range(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Z]{1,3}[1-9][0-9]*(?::[A-Z]{1,3}[1-9][0-9]*)?", value):
        raise ValueError("Use an A1 cell or rectangle")
    ends = value.split(":")
    first = cell_coordinates(ends[0])
    last = cell_coordinates(ends[-1])
    if any(first[i] > last[i] for i in (0, 1)):
        raise ValueError("Invalid range order")
    return first, last


def overlaps_rect(first, second):
    return all(first[0][i] <= second[1][i] and second[0][i] <= first[1][i] for i in (0, 1))


def validate_sheet_name(sheets, name, current=None):
    if not isinstance(name, str) or not name or len(name) > 31 or re.search(r"[:\\/?*\[\]]", name) or name.startswith("'") or name.endswith("'"):
        raise ValueError("Invalid worksheet name")
    if any(sheet is not current and sheet.get("name", "").casefold() == name.casefold() for sheet in sheets):
        raise ValueError("Worksheet name is already used")


def rewrite_sheet_name(expression, old_name, new_name):
    from openpyxl.formula import Tokenizer
    from openpyxl.formula.tokenizer import TokenizerError
    if not expression:
        return expression
    prefix = "=" if expression.startswith("=") else ""
    try:
        tokens = Tokenizer("=" + expression.lstrip("=")).items
    except TokenizerError as error:
        raise UnsupportedStructuralMutation("A formula could not be checked for worksheet references") from error
    rewritten = []
    for token in tokens:
        value = token.value
        if token.type == "FUNC" and token.subtype == "OPEN" and value[:-1].upper().rsplit(".", 1)[-1] in {"INDIRECT", "OFFSET"}:
            raise UnsupportedStructuralMutation("Dynamic references cannot be updated")
        if token.type == "OPERAND" and token.subtype == "RANGE" and "!" in value:
            qualifier, address = value.rsplit("!", 1)
            normalized = qualifier.strip("'").replace("''", "'")
            if ":" in normalized:
                raise UnsupportedStructuralMutation("Multi-sheet references cannot be safely updated")
            if normalized.casefold() == old_name.casefold():
                if new_name is None:
                    raise UnsupportedStructuralMutation("The worksheet is referenced")
                value = "'" + new_name.replace("'", "''") + "'!" + address
        rewritten.append(value)
    return prefix + "".join(rewritten)


def update_sheet_references(package, replacements, additions, old_name, new_name, ignored_part=None):
    names = set(package.namelist()) | additions.keys()
    if any(name.startswith(("xl/pivot", "xl/tables/", "xl/externalLinks/", "xl/slicers/")) or name.lower().endswith("vbaproject.bin")
           for name in names):
        raise UnsupportedStructuralMutation("The workbook has protected references or embedded code")
    parts = [name for name in names if name != ignored_part and re.fullmatch(
        r"xl/(?:workbook\.xml|worksheets/[^/]+\.xml|charts/[^/]+\.xml)", name
    )]
    formula_tags = {tag(SPREADSHEET, element) for element in ("f", "formula", "formula1", "formula2", "definedName")}
    formula_tags.add(tag(CHART, "f"))
    for part in parts:
        root = load_edit_part(package, replacements, additions, part)
        if any(isinstance(node.tag, str) and XML.QName(node).localname == "extLst" for node in root.iter()):
            raise UnsupportedStructuralMutation("The workbook contains protected extensions")
        for node in root.iter():
            if node.tag in formula_tags:
                node.text = rewrite_sheet_name(node.text, old_name, new_name)


def remap_sheet_indices(workbook, old_order, sheets, removed=None):
    visible = next(index for index, node in enumerate(sheets) if node.get("state", "visible") == "visible")
    defined = workbook.find(tag(SPREADSHEET, "definedNames"))
    if defined is not None:
        for entry in list(defined):
            if entry.get("localSheetId") is None:
                continue
            index = bounded_integer(entry.get("localSheetId"), 0, len(old_order) - 1)
            if old_order[index] is removed:
                defined.remove(entry)
            else:
                entry.set("localSheetId", str(sheets.index(old_order[index])))
    for view in workbook.iter(tag(SPREADSHEET, "workbookView")):
        for key in ("activeTab", "firstSheet"):
            index = bounded_integer(view.get(key, "0"), 0, len(old_order) - 1)
            view.set(key, str(visible if old_order[index] is removed else sheets.index(old_order[index])))


STYLES_CHILDREN = (
    "numFmts", "fonts", "fills", "borders", "cellStyleXfs", "cellXfs", "cellStyles", "dxfs", "tableStyles", "colors", "extLst"
)


def ensure_workbook_styles(package, replacements, additions):
    part = "xl/styles.xml"
    if part in replacements or part in additions or part in package.namelist():
        return load_edit_part(package, replacements, additions, part)
    styles = XML.Element(tag(SPREADSHEET, "styleSheet"), nsmap={None: SPREADSHEET})
    fonts = XML.SubElement(styles, tag(SPREADSHEET, "fonts"), count="1")
    font = XML.SubElement(fonts, tag(SPREADSHEET, "font"))
    XML.SubElement(font, tag(SPREADSHEET, "sz"), val="11")
    XML.SubElement(font, tag(SPREADSHEET, "name"), val="Calibri")
    fills = XML.SubElement(styles, tag(SPREADSHEET, "fills"), count="2")
    XML.SubElement(XML.SubElement(fills, tag(SPREADSHEET, "fill")), tag(SPREADSHEET, "patternFill"), patternType="none")
    XML.SubElement(XML.SubElement(fills, tag(SPREADSHEET, "fill")), tag(SPREADSHEET, "patternFill"), patternType="gray125")
    borders = XML.SubElement(styles, tag(SPREADSHEET, "borders"), count="1")
    border = XML.SubElement(borders, tag(SPREADSHEET, "border"))
    for side in ("left", "right", "top", "bottom", "diagonal"):
        XML.SubElement(border, tag(SPREADSHEET, side))
    csx = XML.SubElement(styles, tag(SPREADSHEET, "cellStyleXfs"), count="1")
    XML.SubElement(csx, tag(SPREADSHEET, "xf"), numFmtId="0", fontId="0", fillId="0", borderId="0")
    cx = XML.SubElement(styles, tag(SPREADSHEET, "cellXfs"), count="1")
    XML.SubElement(cx, tag(SPREADSHEET, "xf"), numFmtId="0", fontId="0", fillId="0", borderId="0", xfId="0")
    add_package_part(
        package, replacements, additions, MAIN_PART["xlsx"], part, "styles",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml", XML.tostring(styles)
    )
    return load_edit_part(package, replacements, additions, part)


def styles_section(styles, name):
    later = STYLES_CHILDREN[STYLES_CHILDREN.index(name) + 1:]
    return xml_child(styles, SPREADSHEET, name, later)


def normalize_hex_rgb(value):
    if not isinstance(value, str):
        raise ValueError("Expected RGB hex color string")
    cleaned = value.lstrip("#").upper()
    if len(cleaned) == 8 and re.fullmatch(r"[0-9A-F]{8}", cleaned):
        return cleaned
    if re.fullmatch(r"[0-9A-F]{6}", cleaned):
        return "FF" + cleaned
    raise ValueError("Use a six-digit RGB color")


BUILTIN_NUM_FMTS = {
    "General": 0, "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4,
    "0%": 9, "0.00%": 10, "0.00E+00": 11, "mm-dd-yy": 14, "yyyy-mm-dd": 14,
    "@": 49,
}


def allocate_workbook_style_index(package, replacements, additions, spec, base_index=0):
    """Build or reuse a real cellXfs style in xl/styles.xml from font/fill/border/alignment/numFmt options."""
    styles = ensure_workbook_styles(package, replacements, additions)
    cell_xfs = styles_section(styles, "cellXfs")
    existing_xfs = cell_xfs.findall(tag(SPREADSHEET, "xf"))
    if not existing_xfs:
        base_xf = XML.SubElement(cell_xfs, tag(SPREADSHEET, "xf"), numFmtId="0", fontId="0", fillId="0", borderId="0", xfId="0")
        existing_xfs = [base_xf]
    src_xf = existing_xfs[base_index] if 0 <= base_index < len(existing_xfs) else existing_xfs[0]

    num_fmt_id = int(src_xf.get("numFmtId", "0"))
    font_id = int(src_xf.get("fontId", "0"))
    fill_id = int(src_xf.get("fillId", "0"))
    border_id = int(src_xf.get("borderId", "0"))
    apply_num_fmt = src_xf.get("applyNumberFormat")
    apply_font = src_xf.get("applyFont")
    apply_fill = src_xf.get("applyFill")
    apply_border = src_xf.get("applyBorder")
    apply_alignment = src_xf.get("applyAlignment")

    num_fmt = spec.get("numberFormat", spec.get("numFmt"))
    if num_fmt is not None:
        if isinstance(num_fmt, int):
            num_fmt_id = bounded_integer(num_fmt, 0, 65535)
        elif isinstance(num_fmt, str) and num_fmt in BUILTIN_NUM_FMTS:
            num_fmt_id = BUILTIN_NUM_FMTS[num_fmt]
        elif isinstance(num_fmt, str) and 1 <= len(num_fmt) <= 255:
            num_fmts = styles_section(styles, "numFmts")
            found_fmt = next((n for n in num_fmts.findall(tag(SPREADSHEET, "numFmt")) if n.get("formatCode") == num_fmt), None)
            if found_fmt is not None:
                num_fmt_id = int(found_fmt.get("numFmtId", "164"))
            else:
                used_ids = [int(n.get("numFmtId", "163")) for n in num_fmts.findall(tag(SPREADSHEET, "numFmt"))]
                num_fmt_id = max([163] + used_ids) + 1
                XML.SubElement(num_fmts, tag(SPREADSHEET, "numFmt"), numFmtId=str(num_fmt_id), formatCode=num_fmt)
                num_fmts.set("count", str(len(num_fmts.findall(tag(SPREADSHEET, "numFmt")))))
        else:
            raise ValueError("Invalid number format")
        apply_num_fmt = "1"

    font_spec = spec.get("font") if isinstance(spec.get("font"), dict) else {}
    merged_font = dict(font_spec)
    for k in ("bold", "italic", "underline", "strike", "fontSizePt", "fontFamily", "fontColor"):
        if k in spec and k not in merged_font:
            merged_font[k] = spec[k]
    if merged_font:
        fonts = styles_section(styles, "fonts")
        font_list = fonts.findall(tag(SPREADSHEET, "font"))
        new_font = deepcopy(font_list[font_id]) if 0 <= font_id < len(font_list) else XML.Element(tag(SPREADSHEET, "font"))
        for key, el_name in (("bold", "b"), ("italic", "i"), ("underline", "u"), ("strike", "strike")):
            if key in merged_font:
                existing = new_font.find(tag(SPREADSHEET, el_name))
                if merged_font[key]:
                    if existing is None:
                        new_font.insert(0, XML.Element(tag(SPREADSHEET, el_name)))
                    elif existing.get("val") in ("0", "false", "off", "none"):
                        del existing.attrib["val"]
                elif existing is not None:
                    new_font.remove(existing)
        size_val = merged_font.get("fontSizePt", merged_font.get("size"))
        if size_val is not None:
            sz = xml_child(new_font, SPREADSHEET, "sz", ("color", "name", "family", "scheme"))
            sz.set("val", str(bounded_integer(round(float(size_val)), 1, 400)))
        color_val = merged_font.get("fontColor", merged_font.get("color"))
        if color_val is not None:
            clr = xml_child(new_font, SPREADSHEET, "color", ("name", "family", "scheme"))
            clr.attrib.clear()
            clr.set("rgb", normalize_hex_rgb(color_val))
        family_val = merged_font.get("fontFamily", merged_font.get("name"))
        if family_val is not None:
            nm = xml_child(new_font, SPREADSHEET, "name", ("family", "scheme"))
            nm.set("val", str(family_val)[:128])
        fonts.append(new_font)
        font_id = len(font_list)
        fonts.set("count", str(font_id + 1))
        apply_font = "1"

    fill_val = spec.get("backgroundColor", spec.get("fill"))
    if fill_val is not None:
        fills = styles_section(styles, "fills")
        fill_list = fills.findall(tag(SPREADSHEET, "fill"))
        new_fill = XML.Element(tag(SPREADSHEET, "fill"))
        if fill_val == "none" or (isinstance(fill_val, dict) and fill_val.get("type") == "none"):
            XML.SubElement(new_fill, tag(SPREADSHEET, "patternFill"), patternType="none")
        else:
            rgb = normalize_hex_rgb(fill_val["color"] if isinstance(fill_val, dict) else fill_val)
            pf = XML.SubElement(new_fill, tag(SPREADSHEET, "patternFill"), patternType="solid")
            XML.SubElement(pf, tag(SPREADSHEET, "fgColor"), rgb=rgb)
            XML.SubElement(pf, tag(SPREADSHEET, "bgColor"), indexed="64")
        fills.append(new_fill)
        fill_id = len(fill_list)
        fills.set("count", str(fill_id + 1))
        apply_fill = "1"

    border_spec = spec.get("border")
    if border_spec is not None:
        borders = styles_section(styles, "borders")
        border_list = borders.findall(tag(SPREADSHEET, "border"))
        new_border = XML.Element(tag(SPREADSHEET, "border"))
        allowed_styles = {"none", "thin", "medium", "thick", "dashed", "dotted", "double", "hair"}
        default_style = border_spec.get("style", "thin") if isinstance(border_spec, dict) else (border_spec if isinstance(border_spec, str) else "thin")
        default_color = border_spec.get("color", "000000") if isinstance(border_spec, dict) else "000000"
        for side in ("left", "right", "top", "bottom", "diagonal"):
            side_el = XML.SubElement(new_border, tag(SPREADSHEET, side))
            if side == "diagonal":
                continue
            side_cfg = border_spec.get(side) if isinstance(border_spec, dict) and side in border_spec else (
                None if isinstance(border_spec, dict) and any(k in border_spec for k in ("left", "right", "top", "bottom"))
                else {"style": default_style, "color": default_color}
            )
            if isinstance(side_cfg, str):
                side_cfg = {"style": side_cfg, "color": default_color}
            if isinstance(side_cfg, dict):
                st = side_cfg.get("style", "thin")
                if st not in allowed_styles:
                    raise ValueError(f"Unsupported border style: {st}")
                if st != "none":
                    side_el.set("style", st)
                    XML.SubElement(side_el, tag(SPREADSHEET, "color"), rgb=normalize_hex_rgb(side_cfg.get("color", default_color)))
        borders.append(new_border)
        border_id = len(border_list)
        borders.set("count", str(border_id + 1))
        apply_border = "1"

    new_xf = deepcopy(src_xf)
    new_xf.set("numFmtId", str(num_fmt_id))
    new_xf.set("fontId", str(font_id))
    new_xf.set("fillId", str(fill_id))
    new_xf.set("borderId", str(border_id))
    if apply_num_fmt:
        new_xf.set("applyNumberFormat", apply_num_fmt)
    if apply_font:
        new_xf.set("applyFont", apply_font)
    if apply_fill:
        new_xf.set("applyFill", apply_fill)
    if apply_border:
        new_xf.set("applyBorder", apply_border)

    align_spec = spec.get("alignment") if isinstance(spec.get("alignment"), dict) else {}
    merged_align = dict(align_spec)
    for k in ("horizontal", "vertical", "wrapText", "textRotation"):
        if k in spec and k not in merged_align:
            merged_align[k] = spec[k]
    if merged_align:
        align_el = new_xf.find(tag(SPREADSHEET, "alignment"))
        if align_el is None:
            align_el = XML.SubElement(new_xf, tag(SPREADSHEET, "alignment"))
        if "horizontal" in merged_align:
            h = merged_align["horizontal"]
            if h not in {"general", "left", "center", "right", "fill", "justify"}:
                raise ValueError("Invalid horizontal alignment")
            align_el.set("horizontal", h)
        if "vertical" in merged_align:
            v = merged_align["vertical"]
            if v not in {"top", "center", "bottom", "justify"}:
                raise ValueError("Invalid vertical alignment")
            align_el.set("vertical", v)
        if "wrapText" in merged_align:
            align_el.set("wrapText", "1" if merged_align["wrapText"] else "0")
        if "textRotation" in merged_align:
            align_el.set("textRotation", str(bounded_integer(merged_align["textRotation"], 0, 180)))
        new_xf.set("applyAlignment", "1")
    elif apply_alignment:
        new_xf.set("applyAlignment", apply_alignment)

    cell_xfs.append(new_xf)
    new_index = len(existing_xfs)
    cell_xfs.set("count", str(new_index + 1))
    replacements["xl/styles.xml"] = styles
    return new_index


def allocate_workbook_dxf(package, replacements, additions, style_spec):
    """Append a differential format (<dxf>) entry in xl/styles.xml for conditional formatting."""
    styles = ensure_workbook_styles(package, replacements, additions)
    dxfs = styles_section(styles, "dxfs")
    existing = dxfs.findall(tag(SPREADSHEET, "dxf"))
    dxf = XML.SubElement(dxfs, tag(SPREADSHEET, "dxf"))
    if any(k in style_spec for k in ("bold", "italic", "fontColor", "color")):
        font = XML.SubElement(dxf, tag(SPREADSHEET, "font"))
        if style_spec.get("bold"):
            XML.SubElement(font, tag(SPREADSHEET, "b"))
        if style_spec.get("italic"):
            XML.SubElement(font, tag(SPREADSHEET, "i"))
        fc = style_spec.get("fontColor", style_spec.get("color"))
        if fc:
            XML.SubElement(font, tag(SPREADSHEET, "color"), rgb=normalize_hex_rgb(fc))
    bg = style_spec.get("backgroundColor", style_spec.get("fill"))
    if bg:
        fill = XML.SubElement(dxf, tag(SPREADSHEET, "fill"))
        pf = XML.SubElement(fill, tag(SPREADSHEET, "patternFill"), patternType="solid")
        XML.SubElement(pf, tag(SPREADSHEET, "bgColor"), rgb=normalize_hex_rgb(bg))
        XML.SubElement(pf, tag(SPREADSHEET, "fgColor"), rgb=normalize_hex_rgb(bg))
    dxfs.set("count", str(len(existing) + 1))
    replacements["xl/styles.xml"] = styles
    return len(existing)


def update_sheet_metadata(package, replacements, additions, removed, operation):
    workbook_part = MAIN_PART["xlsx"]
    workbook = load_edit_part(package, replacements, additions, workbook_part)
    sheets = workbook.find(tag(SPREADSHEET, "sheets"))
    op = operation["op"]
    if op == "xlsx.add_sheet":
        name = operation["name"]
        validate_sheet_name(sheets, name)
        target = allocate_part(package, additions, "xl/worksheets/sheet", ".xml")
        worksheet = XML.Element(tag(SPREADSHEET, "worksheet"), nsmap={None: SPREADSHEET})
        XML.SubElement(worksheet, tag(SPREADSHEET, "sheetData"))
        rid = add_package_part(package, replacements, additions, workbook_part, target, "worksheet",
                               "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
                               XML.tostring(worksheet))
        sheet_id = max([0] + [int(sheet.attrib["sheetId"]) for sheet in sheets]) + 1
        node = XML.SubElement(sheets, tag(SPREADSHEET, "sheet"), name=name, sheetId=str(sheet_id))
        node.set(tag(OFFICE_REL, "id"), rid)
        return str(sheet_id), target
    if op == "xlsx.set_defined_name":
        name = operation["name"]
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]{0,254}", name) or re.fullmatch(r"[A-Za-z]{1,3}[0-9]+|R|C|R[0-9]+C[0-9]+", name, re.I):
            raise ValueError("Invalid defined name")
        names = xml_child(workbook, SPREADSHEET, "definedNames", ("calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "extLst"))
        local_idx = None
        if operation.get("localSheetId") is not None:
            local_idx = str(bounded_integer(operation["localSheetId"], 0, len(sheets) - 1))
        found = next(
            (node for node in names if node.get("localSheetId") == local_idx and node.get("name", "").casefold() == name.casefold()),
            None,
        )
        if operation.get("range") is None and operation.get("formula") is None:
            if found is not None:
                names.remove(found)
            return
        if found is None:
            found = XML.SubElement(names, tag(SPREADSHEET, "definedName"), name=name)
            if local_idx is not None:
                found.set("localSheetId", local_idx)
        if "formula" in operation and operation["formula"] is not None:
            expr = str(operation["formula"]).lstrip("=").strip()
            if not expr or len(expr) > 2048:
                raise ValueError("Invalid defined name formula")
            found.text = expr
        else:
            reference = operation["range"]
            bounded_sheet_range(reference)
            sheet = next((sheet for sheet in sheets if sheet.get("sheetId") == str(operation["sheetId"])), None)
            if sheet is None:
                raise ValueError("Unknown worksheet")
            absolute = re.sub(r"([A-Z]+)([0-9]+)", r"$\1$\2", reference)
            found.text = "'" + sheet.attrib["name"].replace("'", "''") + "'!" + absolute
        return
    current = next((i for i, sheet in enumerate(sheets) if sheet.get("sheetId") == str(operation["sheetId"])), None)
    if current is None:
        raise ValueError("Unknown worksheet")
    sheet = sheets[current]
    if op == "xlsx.set_sheet_visibility":
        state = operation["state"]
        if state not in {"visible", "hidden", "veryHidden"}:
            raise ValueError("Invalid worksheet visibility")
        if state != "visible" and not any(node is not sheet and node.get("state", "visible") == "visible" for node in sheets):
            raise ValueError("One worksheet must remain visible")
        sheet.set("state", state)
        if state != "visible":
            first_visible = next(i for i, node in enumerate(sheets) if node.get("state", "visible") == "visible")
            for view in workbook.iter(tag(SPREADSHEET, "workbookView")):
                if int(view.get("activeTab", "0")) == current:
                    view.set("activeTab", str(first_visible))
        return
    order = list(sheets)
    if op == "xlsx.rename_sheet":
        name = operation["name"]
        validate_sheet_name(sheets, name, sheet)
        update_sheet_references(package, replacements, additions, sheet.attrib["name"], name)
        sheet.set("name", name)
        return
    if op == "xlsx.duplicate_sheet":
        new_name = operation["name"]
        validate_sheet_name(sheets, new_name)
        rels = load_edit_part(package, replacements, additions, "xl/_rels/workbook.xml.rels")
        relationship = next(node for node in rels if node.get("Id") == sheet.attrib[tag(OFFICE_REL, "id")])
        src_target = resolve_relationship("xl", relationship.attrib["Target"])
        src_part = load_edit_part(package, replacements, additions, src_target)
        cloned = deepcopy(src_part)
        # Strip external relationship children like drawings/tableParts that need unique target parts.
        for strip_tag in ("drawing", "legacyDrawing", "legacyDrawingHF", "tableParts", "oleObjects", "controls"):
            for child in list(cloned.findall(tag(SPREADSHEET, strip_tag))):
                cloned.remove(child)
        for view in cloned.iter(tag(SPREADSHEET, "sheetView")):
            view.attrib.pop("tabSelected", None)
        target = allocate_part(package, additions, "xl/worksheets/sheet", ".xml")
        rid = add_package_part(
            package, replacements, additions, workbook_part, target, "worksheet",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
            XML.tostring(cloned),
        )
        sheet_id = max([0] + [int(s.attrib["sheetId"]) for s in sheets]) + 1
        node = XML.SubElement(sheets, tag(SPREADSHEET, "sheet"), name=new_name, sheetId=str(sheet_id))
        node.set(tag(OFFICE_REL, "id"), rid)
        return
    if op in {"xlsx.remove_empty_sheet", "xlsx.remove_sheet"}:
        if len(sheets) == 1 or not any(node is not sheet and node.get("state", "visible") == "visible" for node in sheets):
            raise ValueError("One worksheet must remain visible")
        rels = load_edit_part(package, replacements, additions, "xl/_rels/workbook.xml.rels")
        relationship = next(node for node in rels if node.get("Id") == sheet.attrib[tag(OFFICE_REL, "id")])
        target = resolve_relationship("xl", relationship.attrib["Target"])
        sheet_part = load_edit_part(package, replacements, additions, target)
        if op == "xlsx.remove_empty_sheet":
            if any(node.tag in {tag(SPREADSHEET, name) for name in (
                "c", "drawing", "conditionalFormatting", "tableParts", "dataValidations", "hyperlinks", "extLst"
            )} for node in sheet_part.iter()):
                raise UnsupportedStructuralMutation("Only an empty worksheet without dependent parts can be removed")
        else:
            # General sheet removal still guards against orphaned pivot/table/drawing parts and cross-sheet references.
            if any(node.tag in {tag(SPREADSHEET, name) for name in ("drawing", "tableParts")} for node in sheet_part.iter()):
                raise UnsupportedStructuralMutation("Worksheet has attached drawings or tables that must be removed first")
        update_sheet_references(package, replacements, additions, sheet.attrib["name"], None, target)
        sheets.remove(sheet)
        rels.remove(relationship)
        types = load_edit_part(package, replacements, additions, "[Content_Types].xml")
        for entry in list(types):
            if entry.get("PartName") == "/" + target:
                types.remove(entry)
        if target in additions:
            additions.pop(target)
            replacements.pop(target, None)
        else:
            removed.add(target)
        sheet_rels_path = f"xl/worksheets/_rels/{PurePosixPath(target).name}.rels"
        if sheet_rels_path in package.namelist():
            removed.add(sheet_rels_path)
        additions.pop(sheet_rels_path, None)
        remap_sheet_indices(workbook, order, sheets, sheet)
        return
    if op != "xlsx.reorder_sheet":
        raise ValueError("Unsupported worksheet operation")
    target_index = bounded_integer(operation["toIndex"], 0, len(order) - 1)
    sheets.remove(sheet)
    sheets.insert(target_index, sheet)
    remap_sheet_indices(workbook, order, sheets)


def excel_string_formula(text):
    if type(text) in (int, float) and math.isfinite(text):
        return str(text)
    if not isinstance(text, str) or len(text) > 240 or any(c in text for c in "\r\n"):
        raise ValueError("Use a bounded literal")
    return '"' + text.replace('"', '""') + '"'


def update_sheet_options(package, replacements, additions, operation):
    part = operation["sheetPart"]
    if not re.fullmatch(r"xl/worksheets/[^/]+\.xml", part):
        raise ValueError("Invalid worksheet part")
    sheet = load_edit_part(package, replacements, additions, part)
    op = operation["op"]
    if op == "xlsx.set_page_setup":
        setup = sheet_node(sheet, "pageSetup")
        orientation = operation.get("orientation", "portrait")
        if orientation not in {"portrait", "landscape"}:
            raise ValueError("Invalid worksheet orientation")
        setup.set("orientation", orientation)
        for key, limit in (("paperSize", 118), ("fitToWidth", 1000), ("fitToHeight", 1000), ("scale", 400)):
            if key in operation:
                setup.set(key, str(bounded_integer(operation[key], 10 if key == "scale" else 0, limit)))
        if "fitToWidth" in operation or "fitToHeight" in operation:
            props = sheet_node(sheet, "sheetPr")
            xml_child(props, SPREADSHEET, "pageSetUpPr").set("fitToPage", "1")
        if isinstance(operation.get("margins"), dict):
            margins = sheet_node(sheet, "pageMargins")
            defaults = {"left": 0.7, "right": 0.7, "top": 0.75, "bottom": 0.75, "header": 0.3, "footer": 0.3}
            for k, default_v in defaults.items():
                val = float(operation["margins"].get(k, margins.get(k, default_v)))
                if not math.isfinite(val) or not 0 <= val <= 10:
                    raise ValueError(f"Invalid page margin {k}")
                margins.set(k, f"{val:.4g}")
        if operation.get("printArea"):
            pa_range = str(operation["printArea"])
            bounded_sheet_range(pa_range)
            wb = load_edit_part(package, replacements, additions, MAIN_PART["xlsx"])
            sheets_el = wb.find(tag(SPREADSHEET, "sheets"))
            wb_sheets = workbook_sheets(package)
            sheet_idx = next((i for i, s in enumerate(wb_sheets) if s["part"] == part), None)
            if sheet_idx is not None:
                sheet_name = wb_sheets[sheet_idx]["name"]
                names = xml_child(wb, SPREADSHEET, "definedNames", ("calcPr", "oleSize", "customWorkbookViews", "pivotCaches", "extLst"))
                found = next(
                    (n for n in names if n.get("name") == "_xlnm.Print_Area" and n.get("localSheetId") == str(sheet_idx)),
                    None,
                )
                if found is None:
                    found = XML.SubElement(names, tag(SPREADSHEET, "definedName"), name="_xlnm.Print_Area", localSheetId=str(sheet_idx))
                absolute = re.sub(r"([A-Z]+)([0-9]+)", r"$\1$\2", pa_range)
                found.text = "'" + sheet_name.replace("'", "''") + "'!" + absolute
        return
    if op == "xlsx.set_column_width":
        width = float(operation["width"])
        if not math.isfinite(width) or not 0.5 <= width <= 255:
            raise ValueError("Column width must be between 0.5 and 255")
        if "column" in operation:
            col = operation["column"]
            if isinstance(col, str) and re.fullmatch(r"[A-Za-z]{1,3}", col):
                col_idx = cell_coordinates(col.upper() + "1")[1]
            else:
                col_idx = bounded_integer(col, 1, 16384)
            start_col = end_col = col_idx
        else:
            start_col = bounded_integer(operation["startCol"], 1, 16384)
            end_col = bounded_integer(operation.get("endCol", start_col), start_col, 16384)
        cols = sheet_node(sheet, "cols")
        for existing in list(cols.findall(tag(SPREADSHEET, "col"))):
            if int(existing.get("min", "0")) == start_col and int(existing.get("max", "0")) == end_col:
                cols.remove(existing)
        XML.SubElement(cols, tag(SPREADSHEET, "col"), min=str(start_col), max=str(end_col),
                       width=f"{width:.2f}", customWidth="1")
        return
    if op == "xlsx.set_row_height":
        height = float(operation["height"])
        if not math.isfinite(height) or not 1.0 <= height <= 409.5:
            raise ValueError("Row height must be between 1 and 409.5 pt")
        start_row = bounded_integer(operation.get("row", operation.get("startRow")), 1, 1048576)
        end_row = bounded_integer(operation.get("endRow", start_row), start_row, min(1048576, start_row + 1000))
        grid = sheet.find(tag(SPREADSHEET, "sheetData"))
        if grid is None:
            grid = sheet_node(sheet, "sheetData")
        existing_rows = {int(r.get("r", "0")): r for r in grid.findall(tag(SPREADSHEET, "row"))}
        for r_num in range(start_row, end_row + 1):
            row_el = existing_rows.get(r_num)
            if row_el is None:
                row_el = XML.Element(tag(SPREADSHEET, "row"), r=str(r_num))
                insert_pos = next((i for i, ch in enumerate(grid) if ch.tag == tag(SPREADSHEET, "row") and int(ch.get("r", "0")) > r_num), len(grid))
                grid.insert(insert_pos, row_el)
            row_el.set("ht", f"{height:.2f}")
            row_el.set("customHeight", "1")
        return
    if op == "xlsx.set_freeze_panes":
        views = sheet_node(sheet, "sheetViews")
        view = views.find(tag(SPREADSHEET, "sheetView"))
        if view is None:
            view = XML.SubElement(views, tag(SPREADSHEET, "sheetView"), workbookViewId="0")
        for old_pane in list(view.findall(tag(SPREADSHEET, "pane"))):
            view.remove(old_pane)
        freeze_row = bounded_integer(operation.get("row", 0), 0, 1000)
        freeze_col = bounded_integer(operation.get("column", 0), 0, 200)
        if freeze_row > 0 or freeze_col > 0:
            top_left = f"{column_name(freeze_col + 1)}{freeze_row + 1}"
            pane = XML.Element(tag(SPREADSHEET, "pane"), topLeftCell=top_left, state="frozen")
            if freeze_col > 0:
                pane.set("xSplit", str(freeze_col))
            if freeze_row > 0:
                pane.set("ySplit", str(freeze_row))
            active_pane = "bottomRight" if (freeze_row > 0 and freeze_col > 0) else ("bottomLeft" if freeze_row > 0 else "topRight")
            pane.set("activePane", active_pane)
            view.insert(0, pane)
        return

    reference = operation["range"]
    bounds = bounded_sheet_range(reference)
    if op == "xlsx.set_merge":
        merges = sheet_node(sheet, "mergeCells")
        existing = next((node for node in merges if node.get("ref") == reference), None)
        if operation.get("merged", True):
            if existing is not None:
                return
            if bounds[0] == bounds[1] or any(overlaps_rect(bounds, bounded_sheet_range(node.attrib["ref"])) for node in merges):
                raise ValueError("Merge overlaps another region or contains one cell")
            for cell in sheet.iter(tag(SPREADSHEET, "c")):
                row, column = cell_coordinates(cell.attrib["r"])
                if (row, column) != bounds[0] and bounds[0][0] <= row <= bounds[1][0] and bounds[0][1] <= column <= bounds[1][1]:
                    if any(child.tag in {tag(SPREADSHEET, field) for field in ("v", "is", "f")} for child in cell):
                        raise ValueError("Merge would hide cell content")
            XML.SubElement(merges, tag(SPREADSHEET, "mergeCell"), ref=reference)
        elif existing is not None:
            merges.remove(existing)
        if len(merges):
            merges.set("count", str(len(merges)))
        else:
            sheet.remove(merges)
    elif op == "xlsx.set_auto_filter":
        auto_filter = sheet_node(sheet, "autoFilter")
        if operation.get("enabled", True) is False:
            sheet.remove(auto_filter)
            return
        auto_filter.set("ref", reference)
        if "values" in operation:
            index = str(bounded_integer(operation["column"], 0, bounds[1][1] - bounds[0][1]))
            if not isinstance(operation["values"], list) or len(operation["values"]) > 500:
                raise ValueError("Filter has too many values")
            for entry in list(auto_filter):
                if entry.get("colId") == index:
                    auto_filter.remove(entry)
            column = XML.Element(tag(SPREADSHEET, "filterColumn"), colId=index)
            auto_filter.insert(0, column)
            filters = XML.SubElement(column, tag(SPREADSHEET, "filters"))
            for value in operation["values"]:
                XML.SubElement(filters, tag(SPREADSHEET, "filter"), val=str(value)[:255])
    elif op == "xlsx.set_data_validation":
        validations = sheet_node(sheet, "dataValidations")
        for existing in list(validations):
            if existing.get("sqref") == reference:
                validations.remove(existing)
        if operation.get("enabled", True):
            kind = operation["kind"]
            validation = XML.SubElement(validations, tag(SPREADSHEET, "dataValidation"), type=kind, sqref=reference,
                                        allowBlank="1" if operation.get("allowBlank", True) else "0",
                                        showErrorMessage="1")
            if operation.get("promptTitle") or operation.get("prompt"):
                validation.set("showInputMessage", "1")
                if operation.get("promptTitle"):
                    validation.set("promptTitle", str(operation["promptTitle"])[:64])
                if operation.get("prompt"):
                    validation.set("prompt", str(operation["prompt"])[:255])
            if operation.get("errorTitle"):
                validation.set("errorTitle", str(operation["errorTitle"])[:64])
            if operation.get("error"):
                validation.set("error", str(operation["error"])[:255])
            allowed_ops = {"between", "notBetween", "equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"}
            if kind == "list":
                if "formula" in operation and isinstance(operation["formula"], str):
                    expr = operation["formula"].lstrip("=").strip()
                    if not expr or len(expr) > 255:
                        raise ValueError("Invalid list validation formula")
                    XML.SubElement(validation, tag(SPREADSHEET, "formula1")).text = expr
                else:
                    values = operation["values"]
                    if not isinstance(values, list) or not values or any(not isinstance(v, str) or "," in v or '"' in v for v in values):
                        raise ValueError("Expected a literal list without delimiters")
                    XML.SubElement(validation, tag(SPREADSHEET, "formula1")).text = excel_string_formula(",".join(values))
            elif kind in {"whole", "decimal", "textLength", "date"}:
                operator = operation.get("operator", "between")
                if operator not in allowed_ops:
                    raise ValueError(f"Unsupported validation operator: {operator}")
                validation.set("operator", operator)
                if operator in {"between", "notBetween"}:
                    lower, upper = operation["min"], operation["max"]
                    if kind != "date" and (any(type(n) not in (int, float) or not math.isfinite(n) for n in (lower, upper)) or lower > upper):
                        raise ValueError("Invalid validation limits")
                    XML.SubElement(validation, tag(SPREADSHEET, "formula1")).text = str(lower)
                    XML.SubElement(validation, tag(SPREADSHEET, "formula2")).text = str(upper)
                else:
                    val = operation.get("value", operation.get("min"))
                    if val is None:
                        raise ValueError("Validation operator requires value")
                    XML.SubElement(validation, tag(SPREADSHEET, "formula1")).text = str(val)
            elif kind == "custom":
                expr = str(operation["formula"]).lstrip("=").strip()
                if not expr or len(expr) > 1024:
                    raise ValueError("Invalid custom validation formula")
                XML.SubElement(validation, tag(SPREADSHEET, "formula1")).text = expr
            else:
                raise ValueError("Unsupported validation rule")
        if len(validations):
            validations.set("count", str(len(validations)))
        else:
            sheet.remove(validations)
    elif op == "xlsx.add_conditional_format":
        priority = max([0] + [int(rule.attrib["priority"]) for rule in sheet.iter(tag(SPREADSHEET, "cfRule"))]) + 1
        container = next((el for el in sheet.findall(tag(SPREADSHEET, "conditionalFormatting")) if el.attrib.get("sqref") == reference), None)
        if container is None:
            container = XML.Element(tag(SPREADSHEET, "conditionalFormatting"), sqref=reference)
            next_tags = {tag(SPREADSHEET, name) for name in SHEET_CHILDREN[SHEET_CHILDREN.index("conditionalFormatting") + 1:]}
            sheet.insert(next((i for i, child in enumerate(sheet) if child.tag in next_tags), len(sheet)), container)
        rule_type = operation.get("type", "colorScale")
        if rule_type == "colorScale":
            rule = XML.SubElement(container, tag(SPREADSHEET, "cfRule"), type="colorScale", priority=str(priority))
            scale = XML.SubElement(rule, tag(SPREADSHEET, "colorScale"))
            has_mid = bool(operation.get("midColor"))
            bounds_cfg = [("min", None)]
            if has_mid:
                bounds_cfg.append((operation.get("midType", "percentile"), str(operation.get("midValue", 50))))
            bounds_cfg.append(("max", None))
            for b_type, b_val in bounds_cfg:
                cfvo = XML.SubElement(scale, tag(SPREADSHEET, "cfvo"), type=b_type)
                if b_val is not None:
                    cfvo.set("val", b_val)
            colors = [operation["minColor"]] + ([operation["midColor"]] if has_mid else []) + [operation["maxColor"]]
            for color in colors:
                XML.SubElement(scale, tag(SPREADSHEET, "color"), rgb=normalize_hex_rgb(color))
        elif rule_type == "dataBar":
            rule = XML.SubElement(container, tag(SPREADSHEET, "cfRule"), type="dataBar", priority=str(priority))
            bar = XML.SubElement(rule, tag(SPREADSHEET, "dataBar"))
            XML.SubElement(bar, tag(SPREADSHEET, "cfvo"), type="min")
            XML.SubElement(bar, tag(SPREADSHEET, "cfvo"), type="max")
            XML.SubElement(bar, tag(SPREADSHEET, "color"), rgb=normalize_hex_rgb(operation.get("color", "638EC6")))
        elif rule_type == "cellIs":
            operator = operation.get("operator", "greaterThan")
            allowed_ops = {"lessThan", "lessThanOrEqual", "equal", "notEqual", "greaterThanOrEqual", "greaterThan", "between", "notBetween"}
            if operator not in allowed_ops:
                raise ValueError(f"Unsupported cellIs operator: {operator}")
            dxf_id = allocate_workbook_dxf(package, replacements, additions, operation.get("style", operation))
            rule = XML.SubElement(container, tag(SPREADSHEET, "cfRule"), type="cellIs", dxfId=str(dxf_id),
                                  priority=str(priority), operator=operator)
            f1 = operation.get("formula", operation.get("value"))
            if f1 is None:
                raise ValueError("cellIs rule requires formula or value")
            XML.SubElement(rule, tag(SPREADSHEET, "formula")).text = str(f1).lstrip("=")
            if operator in {"between", "notBetween"}:
                f2 = operation.get("formula2", operation.get("value2"))
                if f2 is None:
                    raise ValueError("between operator requires formula2 or value2")
                XML.SubElement(rule, tag(SPREADSHEET, "formula")).text = str(f2).lstrip("=")
        elif rule_type == "expression":
            expr = str(operation["formula"]).lstrip("=").strip()
            if not expr:
                raise ValueError("expression rule requires formula")
            dxf_id = allocate_workbook_dxf(package, replacements, additions, operation.get("style", operation))
            rule = XML.SubElement(container, tag(SPREADSHEET, "cfRule"), type="expression", dxfId=str(dxf_id), priority=str(priority))
            XML.SubElement(rule, tag(SPREADSHEET, "formula")).text = expr
        elif rule_type in {"top10", "aboveAverage", "duplicateValues", "uniqueValues"}:
            dxf_id = allocate_workbook_dxf(package, replacements, additions, operation.get("style", operation))
            attrs = {"type": rule_type, "dxfId": str(dxf_id), "priority": str(priority)}
            if rule_type == "top10":
                attrs["rank"] = str(bounded_integer(operation.get("rank", 10), 1, 1000))
                if operation.get("bottom"):
                    attrs["bottom"] = "1"
                if operation.get("percent"):
                    attrs["percent"] = "1"
            elif rule_type == "aboveAverage" and operation.get("above") is False:
                attrs["aboveAverage"] = "0"
            XML.SubElement(container, tag(SPREADSHEET, "cfRule"), **attrs)
        else:
            raise ValueError(f"Unsupported conditional format type: {rule_type}")
    else:
        raise ValueError("Unsupported worksheet operation")


def edit_workbook(package, operations, output):
    replacements = {}
    additions = {}
    removed = set()
    draft_sheets = {}
    changes_cells = False
    for operation in operations:
        op = operation["op"]
        draft_sheet = operation.get("draftSheetKey")
        if draft_sheet is not None:
            if not isinstance(draft_sheet, str) or not re.fullmatch(r"grid-structure:[1-9][0-9]{0,14}", draft_sheet):
                raise ValueError("Invalid draft worksheet identity")
            if op == "xlsx.add_sheet":
                if draft_sheet in draft_sheets:
                    raise ValueError("Duplicate draft worksheet identity")
            else:
                if draft_sheet not in draft_sheets or op not in {
                    "xlsx.set_cell", "xlsx.set_formula", "xlsx.set_cell_style", "xlsx.mutate_rows",
                    "xlsx.mutate_columns", "xlsx.rename_sheet", "xlsx.remove_empty_sheet",
                }:
                    raise ValueError("Unknown draft worksheet")
                sheet_id, sheet_part = draft_sheets[draft_sheet]
                if sheet_part not in additions:
                    raise ValueError("Draft worksheet was deleted")
                operation = {**operation, "sheetId": sheet_id, "sheetPart": sheet_part}
        if op.startswith("chart."):
            changes_cells |= edit_chart(package, "xlsx", operation, replacements)
            continue
        if op in {"xlsx.add_sheet", "xlsx.reorder_sheet", "xlsx.rename_sheet", "xlsx.remove_empty_sheet",
                  "xlsx.remove_sheet", "xlsx.duplicate_sheet", "xlsx.set_sheet_visibility", "xlsx.set_defined_name"}:
            created_sheet = update_sheet_metadata(package, replacements, additions, removed, operation)
            if draft_sheet is not None:
                if created_sheet is not None:
                    draft_sheets[draft_sheet] = created_sheet
                elif op == "xlsx.remove_empty_sheet":
                    del draft_sheets[draft_sheet]
            changes_cells = True
            continue
        if op in {"xlsx.set_merge", "xlsx.add_conditional_format", "xlsx.set_data_validation", "xlsx.set_auto_filter",
                  "xlsx.set_page_setup", "xlsx.set_column_width", "xlsx.set_row_height", "xlsx.set_freeze_panes"}:
            update_sheet_options(package, replacements, additions, operation)
            continue
        changes_cells |= op != "xlsx.set_cell_style"
        if op in {"xlsx.mutate_rows", "xlsx.mutate_columns"}:
            mutate_workbook_grid(package, operation, replacements, additions)
        else:
            update_workbook_cell(package, operation, replacements, additions)
    if changes_cells:
        removed.update(invalidate_calculation(package, replacements))
    serialize_additions(package, replacements, additions, output, "xlsx", removed)


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


def update_workbook_cell(package, operation, replacements, additions=None):
    op = operation["op"]
    if op not in {"xlsx.set_cell", "xlsx.set_formula", "xlsx.set_cell_style"}:
        raise ValueError("Unsupported XLSX operation")
    sheet_name = operation["sheetPart"]
    if not re.fullmatch(r"xl/worksheets/[^/]+\.xml", sheet_name):
        raise ValueError("Invalid worksheet part")
    sheet = load_edit_part(package, replacements, additions if additions is not None else {}, sheet_name)
    if op == "xlsx.set_cell_style":
        if "range" in operation:
            (r1, c1), (r2, c2) = bounded_sheet_range(operation["range"])
            if (r2 - r1 + 1) * (c2 - c1 + 1) > 10_000:
                raise ValueError("Styled cell range exceeds limit")
            addresses = [f"{column_name(c)}{r}" for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]
        else:
            addresses = [operation["address"]]
            cell_coordinates(addresses[0])
        has_rich_style = any(
            k in operation for k in (
                "font", "bold", "italic", "underline", "strike", "fontSizePt", "fontFamily", "fontColor",
                "fill", "backgroundColor", "border", "alignment", "horizontal", "vertical", "wrapText",
                "textRotation", "numFmt", "numberFormat",
            )
        )
        if has_rich_style:
            first_cell = locate_or_insert_cell(sheet, addresses[0])
            base_idx = int(first_cell.get("s", "0"))
            style_idx = allocate_workbook_style_index(
                package, replacements, additions if additions is not None else {}, operation, base_index=base_idx
            )
        else:
            style_idx = bounded_integer(operation["styleIndex"], 0, 65535)
        for addr in addresses:
            cell = locate_or_insert_cell(sheet, addr)
            cell.set("s", str(style_idx))
        replacements[sheet_name] = sheet
        return

    address = operation["address"]
    value = operation.get("value")
    cell_coordinates(address)
    if type(value) not in (str, bool, int, float, type(None)):
        raise ValueError("Expected a scalar cell value")
    assert_editable_cell(sheet, address)
    cell = locate_or_insert_cell(sheet, address)
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
            raise UnsupportedByFormatError("Editing animated images is unsupported")
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
    if action == "render":
        crop_png_region(output, request.get("region"))
    return None


def image_encoding(value):
    return {"png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "webp": "WEBP"}[value.lower()]


def _pdf_page_content_hash(page):
    text = page.extract_text() or ""
    width = round(float(page.mediabox.width), 2)
    height = round(float(page.mediabox.height), 2)
    rot = int(page.rotation or 0)
    annots = len(page.get("/Annots") or [])
    digest = hashlib.sha256(f"{width}x{height}@{rot}|annots={annots}|{text}".encode("utf-8", errors="replace"))
    content = page.get_contents()
    if content is not None:
        digest.update(content.get_data())
    return digest.hexdigest()


def _pdf_outline_items(reader, items=None, depth=0):
    if depth > 6:
        return []
    if items is None:
        try:
            items = reader.outline
        except Exception:
            return []
    out = []
    for item in items or []:
        if isinstance(item, list):
            out.extend(_pdf_outline_items(reader, item, depth + 1))
        else:
            title = getattr(item, "title", None)
            if title is not None:
                try:
                    page_idx = reader.get_destination_page_number(item)
                except Exception:
                    page_idx = None
                out.append({"title": str(title)[:256], "depth": depth, "pageIndex": page_idx})
        if len(out) >= 200:
            break
    return out


def _hex_to_rgb_unit(color_hex):
    cleaned = color_hex.lstrip("#")
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", cleaned):
        raise ValueError("Use a six-digit RGB color")
    return tuple(int(cleaned[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


def _register_reportlab_font(text):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    needs_cjk = any(ord(ch) > 127 for ch in (text or ""))
    if not needs_cjk:
        return "Helvetica"
    font_name = "ArtifactUnicode"
    if font_name in pdfmetrics.getRegisteredFontNames():
        return font_name
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ):
        if Path(path).is_file():
            try:
                pdfmetrics.registerFont(TTFont(font_name, path))
                return font_name
            except Exception:
                pass
    try:
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
        return "HeiseiKakuGo-W5"
    except Exception:
        return "Helvetica"


def _verify_pdf(source, request):
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    issues = []
    checks = []

    def add_check(check_id, status, evidence):
        checks.append({"id": check_id, "status": status, "evidence": evidence})

    def add_issue(severity, code, message, location=None):
        entry = {"severity": severity, "code": code, "message": message}
        if location:
            entry["location"] = location
        if len(issues) < 200:
            issues.append(entry)

    qpdf_target = source
    qpdf_staged = None
    if shutil.which("qpdf") and source.suffix.lower() != ".pdf":
        qpdf_staged = Path.cwd() / "verify-input.pdf"
        shutil.copyfile(source, qpdf_staged)
        qpdf_target = qpdf_staged

    try:
        qpdf_enc_info = ""
        if shutil.which("qpdf"):
            enc_proc = subprocess.run(["qpdf", "--show-encryption", str(qpdf_target)], capture_output=True, text=True)
            qpdf_enc_info = (enc_proc.stdout or enc_proc.stderr or "").strip()

        try:
            reader = PdfReader(source)
        except PdfReadError as error:
            add_issue("error", "PDF_MALFORMED", f"Malformed PDF: {error}")
            add_check("pdf_structure", "failed", f"pypdf failed to parse PDF: {error}")
            return {"ok": False, "coverage": "complete", "checks": checks, "issues": issues, "metrics": {}}

        encrypted = bool(reader.is_encrypted)
        unlocked_empty = False
        if encrypted:
            try:
                unlocked_empty = bool(reader.decrypt(""))
            except Exception:
                unlocked_empty = False
            if not unlocked_empty:
                add_issue("warning", "PDF_ENCRYPTED_USER_PASSWORD", "PDF requires a user password to decrypt content.")
                add_check("pdf_encryption", "failed", "PDF is encrypted and requires a user password.")
                add_check("pdf_structure", "unverified", "Encrypted PDF structure could not be fully read without password.")
                add_check("pdf_text_extraction", "unverified", "Text extraction blocked by user password encryption.")
                add_check("pdf_diff", "unverified", "Differential verification blocked by user password encryption.")
                return {
                    "ok": False,
                    "coverage": "partial",
                    "checks": checks,
                    "issues": issues,
                    "metrics": {"encrypted": True, "userPasswordRequired": True, "encryptionDetail": qpdf_enc_info[:400]},
                }
            add_issue("warning", "PDF_ENCRYPTED_OWNER_ONLY", "PDF is encrypted with owner restrictions (empty user password).")
            add_check("pdf_encryption", "passed", f"Owner-encrypted PDF decrypted with empty user password. {qpdf_enc_info[:200]}".strip())
        else:
            add_check("pdf_encryption", "passed", "PDF is unencrypted.")

        count = len(reader.pages)
        qpdf_errors = 0
        qpdf_warnings = 0
        if shutil.which("qpdf"):
            chk = subprocess.run(["qpdf", "--check", str(qpdf_target)], capture_output=True, text=True)
            if chk.returncode == 2:
                qpdf_errors += 1
                add_issue("error", "PDF_QPDF_STRUCTURE_ERROR", (chk.stderr or chk.stdout or "qpdf check failed")[:400])
            elif chk.returncode == 3:
                qpdf_warnings += 1
                add_issue("warning", "PDF_QPDF_STRUCTURE_WARNING", (chk.stderr or chk.stdout or "qpdf check warning")[:400])
    finally:
        if qpdf_staged is not None:
            try:
                qpdf_staged.unlink(missing_ok=True)
            except OSError:
                pass
    bad_geom = 0
    for idx, page in enumerate(reader.pages):
        w, h = float(page.mediabox.width), float(page.mediabox.height)
        if not (0 < w <= 14400 and 0 < h <= 14400):
            bad_geom += 1
            add_issue("error", "PDF_INVALID_PAGE_BOUNDS", f"Page {idx + 1} mediabox {w}x{h}pt is out of bounds.", f"page:{idx + 1}")
    if not 1 <= count <= 1000:
        bad_geom += 1
        add_issue("error", "PDF_PAGE_COUNT_OUT_OF_BOUNDS", f"PDF page count {count} is out of bounds (1..1000).")
    add_check(
        "pdf_structure",
        "failed" if (qpdf_errors or bad_geom) else "passed",
        f"Inspected {count} page(s); invalid page bounds: {bad_geom}; qpdf errors: {qpdf_errors}, warnings: {qpdf_warnings}.",
    )

    total_chars = 0
    empty_pages = []
    page_texts = []
    page_hashes = []
    extract_errors = 0
    for idx, page in enumerate(reader.pages):
        try:
            txt = (page.extract_text() or "").strip()
        except Exception as exc:
            extract_errors += 1
            txt = ""
            add_issue("error", "PDF_TEXT_EXTRACTION_ERROR", f"Failed extracting text on page {idx + 1}: {exc}", f"page:{idx + 1}")
        page_texts.append(txt)
        total_chars += len(txt)
        if not txt:
            empty_pages.append(idx + 1)
        page_hashes.append(_pdf_page_content_hash(page))
    if empty_pages and len(empty_pages) == count:
        add_issue("info", "PDF_NO_EXTRACTABLE_TEXT", "No extractable text found on any page (may be image-only or blank).")
    add_check(
        "pdf_text_extraction",
        "failed" if extract_errors else "passed",
        f"Extracted {total_chars} character(s) across {count} page(s); pages without text: {len(empty_pages)}.",
    )

    diff_metrics = {}
    compare_path = source.parent / "compare"
    if request.get("hasCompareDocument") and compare_path.is_file():
        try:
            prev_reader = PdfReader(compare_path)
            if prev_reader.is_encrypted:
                prev_reader.decrypt("")
            prev_count = len(prev_reader.pages)
            changed_text_pages = []
            changed_geom_pages = []
            max_mae = 0.0
            min_ssim = 1.0
            for idx in range(min(count, prev_count)):
                prev_p = prev_reader.pages[idx]
                curr_p = reader.pages[idx]
                prev_txt = (prev_p.extract_text() or "").strip()
                if prev_txt != page_texts[idx]:
                    changed_text_pages.append(idx + 1)
                if (
                    round(float(prev_p.mediabox.width), 1) != round(float(curr_p.mediabox.width), 1)
                    or round(float(prev_p.mediabox.height), 1) != round(float(curr_p.mediabox.height), 1)
                    or int(prev_p.rotation or 0) != int(curr_p.rotation or 0)
                ):
                    changed_geom_pages.append(idx + 1)
            if shutil.which("pdftoppm"):
                from PIL import Image
                for idx in range(min(3, count, prev_count)):
                    p1 = Path.cwd() / f"diff-prev-{idx}"
                    p2 = Path.cwd() / f"diff-curr-{idx}"
                    subprocess.run(["pdftoppm", "-f", str(idx + 1), "-l", str(idx + 1), "-scale-to", "512", "-singlefile", "-png", str(compare_path), str(p1)], check=True)
                    subprocess.run(["pdftoppm", "-f", str(idx + 1), "-l", str(idx + 1), "-scale-to", "512", "-singlefile", "-png", str(source), str(p2)], check=True)
                    with Image.open(str(p1) + ".png") as im1, Image.open(str(p2) + ".png") as im2:
                        ssim_val, mae_val = compute_image_ssim_and_mae(im1, im2)
                        min_ssim = min(min_ssim, ssim_val)
                        max_mae = max(max_mae, mae_val)
            diff_metrics = {
                "previousPageCount": prev_count,
                "currentPageCount": count,
                "pageCountDelta": count - prev_count,
                "changedTextPages": changed_text_pages,
                "changedGeometryPages": changed_geom_pages,
                "sampledMinSsim": round(min_ssim, 4),
                "sampledMaxMae": round(max_mae, 2),
            }
            add_check(
                "pdf_diff",
                "passed",
                f"Compared against previous revision ({prev_count} -> {count} pages); text changed on {len(changed_text_pages)} page(s), geometry changed on {len(changed_geom_pages)} page(s), sampled min SSIM={min_ssim:.4f}, max MAE={max_mae:.2f}.",
            )
        except Exception as exc:
            add_check("pdf_diff", "unverified", f"Previous revision could not be compared: {exc}")
    else:
        add_check(
            "pdf_diff",
            "passed",
            f"Baseline revision recorded with {count} per-page content hash(es); no previous revision to diff.",
        )

    return {
        "ok": not any(c["status"] == "failed" for c in checks) and not any(i["severity"] == "error" for i in issues),
        "coverage": "partial" if any(c["status"] == "unverified" for c in checks) else "complete",
        "checks": checks,
        "issues": issues,
        "metrics": {
            "pageCount": count,
            "encrypted": encrypted,
            "totalChars": total_chars,
            "emptyTextPages": empty_pages,
            "pageContentHashes": page_hashes[:50],
            **({"diff": diff_metrics} if diff_metrics else {}),
        },
    }


def _draw_pdf_overlay(original_page, operation):
    from pypdf import PdfReader
    from reportlab.pdfgen.canvas import Canvas

    rect = tuple(float(coordinate) for coordinate in operation["rect"])
    if len(rect) != 4 or not all(math.isfinite(value) and abs(value) <= 14400 for value in rect) \
            or rect[0] >= rect[2] or rect[1] >= rect[3]:
        raise ValueError("Invalid overlay rectangle")
    width, height = float(original_page.mediabox.width), float(original_page.mediabox.height)
    if not 0 < width <= 14400 or not 0 < height <= 14400:
        raise ValueError("PDF overlay page geometry is out of bounds")

    x0, y0, x1, y1 = rect
    if operation.get("origin") == "top-left":
        x0, y0, x1, y1 = rect[0], height - rect[3], rect[2], height - rect[1]
    box_w = x1 - x0
    box_h = y1 - y0
    kind = operation.get("kind", "text")
    opacity = float(operation.get("opacity", 0.35 if kind == "highlight" else 1.0))
    if not math.isfinite(opacity) or not 0.0 <= opacity <= 1.0:
        raise ValueError("Overlay opacity must be in [0, 1]")

    drawing = io.BytesIO()
    canvas = Canvas(drawing, pagesize=(width, height), invariant=1)
    canvas.saveState()
    if opacity < 1.0:
        canvas.setFillAlpha(opacity)
        canvas.setStrokeAlpha(opacity)

    rotation = float(operation.get("rotationDegrees", 0))
    if rotation:
        if not math.isfinite(rotation) or abs(rotation) > 360:
            raise ValueError("Invalid overlay rotation")
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        canvas.translate(cx, cy)
        canvas.rotate(rotation)
        canvas.translate(-cx, -cy)

    if kind == "highlight":
        r, g, b = _hex_to_rgb_unit(operation.get("color", "FFF176"))
        canvas.setFillColorRGB(r, g, b)
        canvas.rect(x0, y0, box_w, box_h, stroke=0, fill=1)
    elif kind == "rect":
        bg = operation.get("backgroundColor", operation.get("fill"))
        bc = operation.get("borderColor", operation.get("color", "1F2937"))
        bw = float(operation.get("borderWidthPt", 1.0))
        if bg:
            canvas.setFillColorRGB(*_hex_to_rgb_unit(bg))
        if bc and bw > 0:
            canvas.setStrokeColorRGB(*_hex_to_rgb_unit(bc))
            canvas.setLineWidth(max(0.1, min(20.0, bw)))
        canvas.rect(x0, y0, box_w, box_h, stroke=1 if (bc and bw > 0) else 0, fill=1 if bg else 0)
    elif kind == "line":
        bc = operation.get("color", operation.get("borderColor", "1F2937"))
        bw = float(operation.get("borderWidthPt", 1.5))
        canvas.setStrokeColorRGB(*_hex_to_rgb_unit(bc))
        canvas.setLineWidth(max(0.1, min(20.0, bw)))
        canvas.line(x0, y0, x1, y1)
    elif kind == "image":
        from reportlab.lib.utils import ImageReader
        img_bytes, _fmt = safe_image(operation["imageBase64"])
        canvas.drawImage(ImageReader(io.BytesIO(img_bytes)), x0, y0, width=box_w, height=box_h, mask="auto")
    elif kind in {"text", "stamp"}:
        text = str(operation.get("text", ""))[:10_000]
        font_size = float(operation.get("fontSizePt", 14 if kind == "stamp" else 11))
        if not math.isfinite(font_size) or not 4 <= font_size <= 200:
            raise ValueError("Overlay fontSizePt must be between 4 and 200")
        bg = operation.get("backgroundColor")
        bc = operation.get("borderColor") or ("DC2626" if kind == "stamp" else None)
        bw = float(operation.get("borderWidthPt", 2.0 if kind == "stamp" else 1.0))
        if bg or bc:
            if bg:
                canvas.setFillColorRGB(*_hex_to_rgb_unit(bg))
            if bc:
                canvas.setStrokeColorRGB(*_hex_to_rgb_unit(bc))
                canvas.setLineWidth(max(0.2, min(12.0, bw)))
            canvas.rect(x0, y0, box_w, box_h, stroke=1 if bc else 0, fill=1 if bg else 0)
        font_name = _register_reportlab_font(text)
        canvas.setFont(font_name, font_size)
        text_color = operation.get("color", "DC2626" if kind == "stamp" else "111827")
        canvas.setFillColorRGB(*_hex_to_rgb_unit(text_color))
        alignment = operation.get("alignment", "center" if kind == "stamp" else "left")
        pad = 4.0
        usable_w = max(10.0, box_w - pad * 2)
        wrapped_lines = []
        for raw_line in (text.splitlines() or [""]):
            if not raw_line:
                wrapped_lines.append("")
                continue
            current = ""
            for ch in raw_line:
                candidate = current + ch
                if canvas.stringWidth(candidate, font_name, font_size) > usable_w and current:
                    wrapped_lines.append(current)
                    current = ch
                else:
                    current = candidate
            if current:
                wrapped_lines.append(current)
        leading = font_size * 1.25
        y_cursor = y1 - pad - font_size if kind != "stamp" else (y0 + y1) / 2.0 + ((len(wrapped_lines) - 1) * leading / 2.0) - font_size * 0.35
        for line in wrapped_lines[:200]:
            if y_cursor < y0 - font_size:
                break
            if alignment == "center":
                canvas.drawCentredString((x0 + x1) / 2.0, y_cursor, line)
            elif alignment == "right":
                canvas.drawRightString(x1 - pad, y_cursor, line)
            else:
                canvas.drawString(x0 + pad, y_cursor, line)
            y_cursor -= leading
    else:
        raise ValueError(f"Unsupported PDF overlay kind: {kind}")

    canvas.restoreState()
    canvas.save()
    drawing.seek(0)
    original_page.merge_page(PdfReader(drawing).pages[0])


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
        canvas = Canvas(str(output), pagesize=size, invariant=1, pdfVersion=(1, 4))
        for text in pages:
            font_name = _register_reportlab_font(text)
            canvas.setFont(font_name, 11)
            y = size[1] - 36
            for line in text.splitlines()[:100]:
                canvas.drawString(36, y, line[:1000])
                y -= 14
            canvas.showPage()
        canvas.save()
        return None
    if action == "verify":
        return _verify_pdf(source, request)
    try:
        reader = PdfReader(source)
        encrypted = bool(reader.is_encrypted)
        if encrypted:
            unlocked = False
            try:
                unlocked = bool(reader.decrypt(""))
            except Exception:
                unlocked = False
            if not unlocked:
                if action == "structure":
                    return {
                        "format": "pdf",
                        "encrypted": True,
                        "userPasswordRequired": True,
                        "pageCount": 0,
                        "pages": [],
                    }
                raise ValueError("Encrypted PDFs require a password")
        count = len(reader.pages)
    except PdfReadError as error:
        raise ValueError("Malformed PDF") from error
    if not 1 <= count <= 1000:
        raise ValueError("PDF page count is out of bounds")
    if action == "structure":
        meta = reader.metadata or {}
        pages_info = []
        for index, page in enumerate(reader.pages):
            annots_raw = page.get("/Annots") or []
            annots_list = []
            for a_ref in annots_raw[:100]:
                try:
                    a_obj = a_ref.get_object()
                    annots_list.append({
                        "subtype": str(a_obj.get("/Subtype", "")),
                        "contents": str(a_obj.get("/Contents", ""))[:200],
                    })
                except Exception:
                    pass
            page_text = page.extract_text() or ""
            has_images = False
            try:
                has_images = len(page.images) > 0
            except Exception:
                pass
            pages_info.append({
                "pageIndex": index,
                "widthPt": float(page.mediabox.width),
                "heightPt": float(page.mediabox.height),
                "rotation": int(page.rotation or 0),
                "charCount": len(page_text),
                "hasImages": has_images,
                "annotationCount": len(annots_raw),
                "annotations": annots_list,
                "pageContentHash": _pdf_page_content_hash(page),
            })
        return {
            "format": "pdf",
            "encrypted": encrypted,
            "pageCount": count,
            "metadata": {
                "title": str(meta.get("/Title", "")) if meta.get("/Title") else None,
                "author": str(meta.get("/Author", "")) if meta.get("/Author") else None,
                "subject": str(meta.get("/Subject", "")) if meta.get("/Subject") else None,
                "creator": str(meta.get("/Creator", "")) if meta.get("/Creator") else None,
                "producer": str(meta.get("/Producer", "")) if meta.get("/Producer") else None,
            },
            "hasFormFields": bool(reader.get_fields()),
            "outline": _pdf_outline_items(reader),
            "pages": pages_info,
        }
    if action == "range":
        first = bounded_integer(request["range"].get("pageIndex", 0), 0, count - 1)
        last = bounded_integer(request["range"].get("endPageIndex", first), first, min(count - 1, first + 19))
        if last == first:
            page = reader.pages[first]
            return {"pageIndex": first, "pageCount": count, "pageContentHash": _pdf_page_content_hash(page),
                    "text": (page.extract_text() or "")[:50_000]}
        pages_text = [
            {"pageIndex": idx, "text": (reader.pages[idx].extract_text() or "")[:25_000]}
            for idx in range(first, last + 1)
        ]
        return {"pageIndex": first, "endPageIndex": last, "pages": pages_text,
                "text": "\n\n".join(p["text"] for p in pages_text)[:50_000]}
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
        page_obj = reader.pages[index]
        media, crop = page_obj.mediabox, page_obj.cropbox
        width = min(float(media.right), float(crop.right)) - max(float(media.left), float(crop.left))
        height = min(float(media.top), float(crop.top)) - max(float(media.bottom), float(crop.bottom))
        if width <= 0 or height <= 0:
            width, height = float(media.width), float(media.height)
        unit = float(page_obj.user_unit)
        unit = unit if math.isfinite(unit) and unit > 0 else 1
        page_size_pt = (width * unit, height * unit)
        if int(page_obj.rotation or 0) % 180 == 90:
            page_size_pt = (page_size_pt[1], page_size_pt[0])
        prefix = str(output) + "-image"
        subprocess.run(["pdftoppm", "-f", str(index + 1), "-l", str(index + 1), "-scale-to", "2048",
                        "-cropbox", "-singlefile", "-png", str(source), prefix], check=True)
        Path(prefix + ".png").replace(output)
        crop_png_region(output, request.get("region"), page_size_pt=page_size_pt)
        return None
    if action != "edit":
        raise ValueError("Unsupported PDF action")

    writer = PdfWriter(clone_from=reader)
    for operation in request["operations"]:
        op = operation["op"]
        if op in {"pdf.delete_text", "pdf.reflow_text", "edit_body_reflow"}:
            raise UnsupportedByFormatError("PDF existing body text deletion/reflow is not supported by format policy.")
        if op == "pdf.reorder_pages":
            order = operation["order"]
            if len(order) != len(writer.pages) or sorted(order) != list(range(len(writer.pages))):
                raise ValueError("The page order must be a complete permutation")
            page_tree = writer._pages.get_object()
            if page_tree["/Count"] == len(page_tree["/Kids"]):
                from pypdf.generic import ArrayObject, NameObject
                children = page_tree["/Kids"]
                page_tree[NameObject("/Kids")] = ArrayObject(children[index] for index in order)
            else:
                rebuilt = PdfWriter()
                for index in order:
                    rebuilt.add_page(writer.pages[index])
                if writer.metadata:
                    rebuilt.add_metadata(dict(writer.metadata))
                writer = rebuilt
        else:
            index = bounded_integer(operation["pageIndex"], 0, len(writer.pages) - 1)
            if op == "pdf.remove_page":
                if len(writer.pages) == 1:
                    raise ValueError("Cannot remove the final page")
                del writer.pages[index]
            elif op == "pdf.rotate_page":
                angle = bounded_integer(operation["degrees"], -360, 360)
                writer.pages[index].rotate(angle)
            elif op == "pdf.add_note":
                rect = tuple(float(coordinate) for coordinate in operation["rect"])
                if len(rect) != 4 or not all(math.isfinite(value) and abs(value) <= 14400 for value in rect) \
                        or rect[0] >= rect[2] or rect[1] >= rect[3]:
                    raise ValueError("Invalid annotation rectangle")
                text = str(operation["text"])[:10_000]
                writer.add_annotation(index, Text(text=text, rect=rect))
            elif op == "pdf.add_overlay":
                _draw_pdf_overlay(writer.pages[index], operation)
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


def verified_video_packet_pts(source, demuxer, sample):
    timestamp = float(sample["timestampSec"])
    digest = str(sample["sha256"])
    if not math.isfinite(timestamp) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("Invalid video sample fingerprint")
    interval = f"{timestamp - 1:.9f}%{timestamp + 1:.9f}"
    completed = subprocess.run(
        ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-f", demuxer,
         "-select_streams", "v:0", "-read_intervals", interval, "-show_packets", "-show_data_hash", "sha256",
         "-show_entries", "packet=pts,pts_time,data_hash", "-of", "json", str(source)],
        capture_output=True, check=True,
    )
    packets = json.loads(completed.stdout).get("packets", [])
    at_timestamp = [packet for packet in packets if "pts" in packet and "pts_time" in packet
                    and abs(float(packet["pts_time"]) - timestamp) <= 0.00000051]
    if len(at_timestamp) != 1 or str(at_timestamp[0].get("data_hash", "")).lower() != f"sha256:{digest}":
        raise ValueError("Video frame packet could not be verified")
    return int(at_timestamp[0]["pts"])


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
               "-threads", "2", "-f", demuxer]
    sample = request.get("frameSample") if action == "render" else None
    if sample is not None:
        pts = verified_video_packet_pts(source, demuxer, sample)
        command += ["-copyts"]
        if float(sample["timestampSec"]) > 2:
            command += ["-seek_timestamp", "1", "-ss", str(float(sample["timestampSec"]) - 2)]
    command += ["-i", str(source)]
    if action == "render":
        filters = "scale=2048:2048:force_original_aspect_ratio=decrease"
        if sample is not None:
            filters = f"select=eq(pts\\,{pts}),{filters}"
        else:
            timestamp = float(request.get("timeSeconds", 0))
            if not 0 <= timestamp <= options["durationSeconds"]:
                raise ValueError("Frame timestamp is out of bounds")
            command += ["-ss", str(timestamp)]
        command += ["-map", "0:v:0", "-frames:v", "1", "-fps_mode", "vfr",
                    "-vf", filters, "-f", "image2", "-c:v", "png"]
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
    if action == "render":
        crop_png_region(output, request.get("region"))
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


def pptx_basic_geometry(shape):
    """Only classify geometry whose complete paint is explicit and reproducible.
    Inherited theme, text, effects, placeholders and groups stay native sprites."""
    if shape.tag != tag(PRESENTATION, "sp") or text_content(shape, DRAWING).strip():
        return None
    if shape.find(".//" + tag(PRESENTATION, "ph")) is not None:
        return None
    if shape.find(tag(PRESENTATION, "style")) is not None:
        return None
    props = shape.find(tag(PRESENTATION, "spPr"))
    transform = shape_transform(shape)
    if props is None or not transform or not transform.get("geomBoundsPt"):
        return None
    if transform["rotationDegrees"] or transform["flipH"] or transform["flipV"]:
        return None
    if any(child.tag not in {tag(DRAWING, n) for n in ("xfrm", "prstGeom", "solidFill", "noFill", "ln")} for child in props):
        return None
    geom = props.find(tag(DRAWING, "prstGeom"))
    if geom is None or geom.get("prst") not in ("rect", "ellipse"):
        return None
    if any(len(child) or child.tag != tag(DRAWING, "avLst") for child in geom):
        return None
    def paint(parent):
        if parent.find(tag(DRAWING, "noFill")) is not None:
            return "none"
        solid = parent.find(tag(DRAWING, "solidFill"))
        if solid is not None and len(solid) == 1:
            color = solid[0]
            if color.tag == tag(DRAWING, "srgbClr") and not len(color) and re.fullmatch(r"[0-9A-Fa-f]{6}", color.get("val", "")):
                return "#" + color.get("val")
        return None
    fill = paint(props)
    line = props.find(tag(DRAWING, "ln"))
    if fill is None or line is None or any(child.tag not in {tag(DRAWING, "solidFill"), tag(DRAWING, "noFill")} for child in line):
        return None
    stroke = paint(line)
    if stroke is None or (stroke != "none" and (set(line.attrib) != {"w"} or not line.get("w", "").isdigit())):
        return None
    return {"kind": geom.get("prst"), "fill": fill, "stroke": stroke,
            "strokeWidthPt": int(line.get("w", "0")) / 12700 if stroke != "none" else 0}


def _pptx_table_rows(shape):
    if shape.tag != tag(PRESENTATION, "graphicFrame"):
        return None
    table = shape.find("./" + tag(DRAWING, "graphic") + "/" + tag(DRAWING, "graphicData") + "/" + tag(DRAWING, "tbl"))
    if table is None:
        return None
    return [[{
        "text": "\n".join(text_content(paragraph, DRAWING) for paragraph in cell.findall("./" + tag(DRAWING, "txBody") + "/" + tag(DRAWING, "p"))),
        "editable": not any(cell.get(attribute) in ("1", "true") for attribute in ("hMerge", "vMerge")),
    } for cell in row.findall(tag(DRAWING, "tc"))] for row in table.findall(tag(DRAWING, "tr"))]


def pptx_shape_order(node, include_table_rows=False):
    # XML parsing already enforces bounded depth; the worker's memory/output
    # budgets apply to the full tree, not an independent shape count.
    children = []
    for shape in node:
        if not isinstance(shape.tag, str) or XML.QName(shape).localname not in {
            "sp", "pic", "graphicFrame", "cxnSp", "grpSp", "contentPart"
        }:
            continue
        props = shape.find("./*/" + tag(PRESENTATION, "cNvPr"))
        if props is None:
            continue
        entry = {"id": props.get("id"), "name": props.get("name"), "type": XML.QName(shape).localname,
                         "text": text_content(shape, DRAWING), "zOrder": len(children),
                         "transform": shape_transform(shape), "basicGeometry": pptx_basic_geometry(shape), "children": pptx_shape_order(shape)}
        table_rows = _pptx_table_rows(shape) if include_table_rows else None
        if table_rows is not None:
            entry["tableRows"] = table_rows
        children.append(entry)
    return children


def workbook_sheets(package, replacements=None, additions=None):
    workbook_part = MAIN_PART["xlsx"]
    relations_part = "xl/_rels/workbook.xml.rels"
    if replacements is None:
        root = parse_xml(package.read(workbook_part))
        relations = parse_xml(package.read(relations_part))
    else:
        root = load_edit_part(package, replacements, additions, workbook_part)
        relations = load_edit_part(package, replacements, additions, relations_part)
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


def mutate_workbook_grid(package, operation, replacements, additions):
    mutation = GridMutation(operation)
    if any(name.startswith(("xl/pivot", "xl/tables/", "xl/drawings/", "xl/externalLinks/", "xl/comments"))
           for name in package.namelist()):
        raise UnsupportedStructuralMutation("Pivot tables, structured tables, drawings, comments and external links are protected")
    sheets = workbook_sheets(package, replacements, additions)
    target = next((sheet for sheet in sheets if sheet["id"] == str(operation["sheetId"])), None)
    if target is None:
        raise ValueError("Unknown worksheet")
    for sheet in sheets:
        part = sheet["part"]
        root = load_edit_part(package, replacements, additions, part)
        for formula in root.iter(tag(SPREADSHEET, "f")):
            if formula.get("t") not in (None, "normal"):
                raise UnsupportedStructuralMutation("Shared, table, and array formulas are protected")
            formula.text = rewrite_workbook_formula(formula.text, sheet["name"], target["name"], mutation)
        if sheet == target:
            shift_worksheet_grid(root, mutation)
        replacements[part] = root

    workbook_part = MAIN_PART["xlsx"]
    workbook = load_edit_part(package, replacements, additions, workbook_part)
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


def search_workbook_sheet(package, options):
    sheet = next((sheet for sheet in workbook_sheets(package) if sheet["id"] == str(options["sheetId"])), None)
    if sheet is None:
        raise ValueError("Unknown worksheet")
    query = str(options["gridSearch"]).strip().lower()
    if not query:
        return {"match": None}
    cursor = (int(options.get("afterRow", -1)) + 1, int(options.get("afterCol", -1)) + 1)
    matching_strings = set()
    if "xl/sharedStrings.xml" in package.namelist():
        with package.open("xl/sharedStrings.xml") as stream:
            for index, entry in enumerate(spreadsheet_elements(stream, "si")):
                if query in text_content(entry, SPREADSHEET).lower():
                    matching_strings.add(index)

    best = None
    with package.open(sheet["part"]) as stream:
        for row in spreadsheet_elements(stream, "row"):
            for cell in row.findall(tag(SPREADSHEET, "c")):
                address = cell.get("r")
                if not address:
                    continue
                cell_type = cell.get("t")
                value = cell.findtext(tag(SPREADSHEET, "v")) or ""
                formula = cell.findtext(tag(SPREADSHEET, "f")) or ""
                if cell_type == "s":
                    matches = value.isdecimal() and int(value) in matching_strings
                else:
                    if cell_type == "inlineStr":
                        value = text_content(cell, SPREADSHEET)
                    matches = query in value.lower()
                if matches or (formula and query in ("=" + formula).lower()):
                    coordinate = cell_coordinates(address)
                    candidate = (coordinate <= cursor, coordinate)
                    if best is None or candidate < best:
                        best = candidate
    if best is None:
        return {"match": None}
    row, col = best[1]
    return {"match": {"row": row - 1, "col": col - 1}}


def spreadsheet_elements(stream, name):
    for _, element in XML.iterparse(stream, events=("end",), tag=tag(SPREADSHEET, name),
                                   resolve_entities=False, no_network=True):
        yield element
        element.clear()
        parent = element.getparent()
        while parent is not None and element.getprevious() is not None:
            del parent[0]


def _xlsx_ui_color(node):
    value = node.get("rgb", "") if node is not None else ""
    return "#" + value[-6:].lower() if re.fullmatch(r"(?:[0-9A-Fa-f]{2})?[0-9A-Fa-f]{6}", value) else None


def read_workbook_range(package, options, max_cells=1000):
    sheet = next((sheet for sheet in workbook_sheets(package) if sheet["id"] == str(options["sheetId"])), None)
    if sheet is None:
        raise ValueError("Unknown worksheet")
    bounds = options.get("rangeA1", "A1").split(":")
    first_row, first_column = cell_coordinates(bounds[0])
    last_row, last_column = cell_coordinates(bounds[-1])
    if len(bounds) > 2 or first_row > last_row or first_column > last_column \
            or (last_row - first_row + 1) * (last_column - first_column + 1) > max_cells:
        raise ValueError("Requested worksheet range is out of bounds")

    raw_cells = []
    needed_ss = set()
    row_tag = tag(SPREADSHEET, "row")
    cell_tag = tag(SPREADSHEET, "c")
    with package.open(sheet["part"]) as sheet_stream:
        for _event, row_el in XML.iterparse(sheet_stream, events=("end",), tag=row_tag, resolve_entities=False, no_network=True):
            row_attr = row_el.get("r")
            row_num_hint = int(row_attr) if row_attr and row_attr.isdigit() else None
            if row_num_hint is not None and row_num_hint > last_row:
                row_el.clear()
                break
            if row_num_hint is None or first_row <= row_num_hint <= last_row:
                for cell in row_el.findall(cell_tag):
                    address = cell.get("r")
                    if not address:
                        continue
                    row, column = cell_coordinates(address)
                    if not (first_row <= row <= last_row and first_column <= column <= last_column):
                        continue
                    formula = cell.find(tag(SPREADSHEET, "f"))
                    value = cell.findtext(tag(SPREADSHEET, "v"))
                    cell_type = cell.get("t")
                    ss_idx = None
                    if cell_type == "s" and value is not None:
                        ss_idx = bounded_integer(value, 0, 10_000_000)
                        needed_ss.add(ss_idx)
                    elif cell_type == "inlineStr":
                        value = text_content(cell, SPREADSHEET)
                    raw_cells.append((address, value, cell_type, ss_idx, (formula.text or "") if formula is not None else None, int(cell.get("s", "0"))))
            row_el.clear()
            parent = row_el.getparent()
            if parent is not None:
                while row_el.getprevious() is not None:
                    del parent[0]

    ss_lookup = {}
    if needed_ss:
        if "xl/sharedStrings.xml" not in package.namelist():
            raise ValueError("Worksheet references missing shared strings")
        max_ss = max(needed_ss)
        si_tag = tag(SPREADSHEET, "si")
        with package.open("xl/sharedStrings.xml") as ss_stream:
            for idx, (_event, si_el) in enumerate(XML.iterparse(ss_stream, events=("end",), tag=si_tag, resolve_entities=False, no_network=True)):
                if idx in needed_ss:
                    ss_lookup[idx] = text_content(si_el, SPREADSHEET)
                si_el.clear()
                parent = si_el.getparent()
                if parent is not None:
                    while si_el.getprevious() is not None:
                        del parent[0]
                if idx >= max_ss:
                    break
        if len(ss_lookup) != len(needed_ss):
            raise ValueError("Worksheet references out-of-bounds shared string index")

    # Read native font style metadata only for cells in the requested range.
    cell_styles = {}
    if "xl/styles.xml" in package.namelist():
        styles = parse_xml(package.read("xl/styles.xml"))
        fonts = styles.find(tag(SPREADSHEET, "fonts"))
        fills = styles.find(tag(SPREADSHEET, "fills"))
        xfs = styles.find(tag(SPREADSHEET, "cellXfs"))
        if xfs is not None:
            for idx, xf in enumerate(xfs):
                style = {}
                font_idx = int(xf.get("fontId", "0"))
                if fonts is not None and 0 <= font_idx < len(fonts):
                    for name, element in (("bold", "b"), ("italic", "i"), ("underline", "u"), ("strike", "strike")):
                        mark = fonts[font_idx].find(tag(SPREADSHEET, element))
                        if mark is not None and mark.get("val", "1") not in ("0", "false", "off", "none"):
                            style[name] = True
                    font_color = _xlsx_ui_color(fonts[font_idx].find(tag(SPREADSHEET, "color")))
                    if font_color is not None:
                        style["fontColor"] = font_color
                fill_idx = int(xf.get("fillId", "0"))
                if fills is not None and 0 <= fill_idx < len(fills):
                    pattern = fills[fill_idx].find(tag(SPREADSHEET, "patternFill"))
                    if pattern is not None and pattern.get("patternType") == "solid":
                        background = _xlsx_ui_color(pattern.find(tag(SPREADSHEET, "fgColor")))
                        if background is not None:
                            style["backgroundColor"] = background
                alignment = xf.find(tag(SPREADSHEET, "alignment"))
                if alignment is not None and alignment.get("horizontal"):
                    style["horizontal"] = alignment.get("horizontal")
                cell_styles[idx] = style
    cells = []
    for address, value, cell_type, ss_idx, formula_text, style_index in raw_cells:
        if ss_idx is not None:
            value = ss_lookup[ss_idx]
        record = {"address": address, "value": value, "type": cell_type, "bold": False,
                  **cell_styles.get(style_index, {})}
        if formula_text is not None:
            record.update(formula=formula_text, formulaStatus=(
                "unevaluated_unsupported" if value in (None, "") else
                "error_formula" if cell_type == "e" else "cached_existing"
            ))
        cells.append(record)
    return {"sheetId": sheet["id"], "rangeA1": options.get("rangeA1", "A1"), "cells": cells}


SAFE_CALC_FUNCTIONS = {
    "ABS", "AND", "AVERAGE", "COUNT", "COUNTA", "IF", "IFERROR", "MAX", "MIN",
    "NOT", "OR", "ROUND", "ROUNDDOWN", "ROUNDUP", "SUM", "SUMIF", "SUMIFS",
    "COUNTIF", "PRODUCT", "MOD", "SQRT", "POWER",
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


def evaluate_workbook_range(package, source, options, result, max_cells=1000):
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
                calculated = read_workbook_range(evaluated, {**options, "sheetId": sheet_id}, max_cells)
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


def xml_child(parent, namespace, name, before=(), **attributes):
    node = parent.find(tag(namespace, name))
    if node is None:
        node = XML.Element(tag(namespace, name), **attributes)
        later = {tag(namespace, sibling) for sibling in before}
        offset = next((i for i, child in enumerate(parent) if child.tag in later), len(parent))
        parent.insert(offset, node)
    return node


def load_edit_part(package, replacements, additions, part):
    content = replacements.get(part)
    if content is None:
        content = parse_xml(additions[part] if part in additions else package.read(part))
        replacements[part] = content
    return content


def add_package_part(package, replacements, additions, source, destination, relationship_type, content_type, data):
    source_path = PurePosixPath(source)
    relationship_path = str(source_path.parent / "_rels" / (source_path.name + ".rels"))
    if relationship_path not in package.namelist() and relationship_path not in additions:
        additions[relationship_path] = XML.tostring(XML.Element(tag(RELATIONSHIPS, "Relationships")))
    relationships = load_edit_part(package, replacements, additions, relationship_path)
    used = {node.get("Id") for node in relationships}
    identifier = next(f"rId{i}" for i in range(1, len(used) + 2) if f"rId{i}" not in used)
    XML.SubElement(relationships, tag(RELATIONSHIPS, "Relationship"), Id=identifier,
                   Type=OFFICE_REL + "/" + relationship_type,
                   Target=posixpath.relpath(destination, str(source_path.parent)))
    types = load_edit_part(package, replacements, additions, "[Content_Types].xml")
    XML.SubElement(types, tag(CONTENT_TYPES, "Override"), PartName="/" + destination, ContentType=content_type)
    additions[destination] = data
    return identifier


def allocate_part(package, additions, prefix, suffix):
    used = set(package.namelist()) | additions.keys()
    return next(f"{prefix}{i}{suffix}" for i in range(1, len(used) + 2) if f"{prefix}{i}{suffix}" not in used)


def serialize_additions(package, replacements, additions, output, fmt, removed=()):
    prepared = {part: XML.tostring(replacements[part], encoding="UTF-8", xml_declaration=True)
                if part in replacements else data for part, data in additions.items()}
    write_package(package, replacements, output, fmt, removed, prepared)


def safe_image(encoded):
    from PIL import Image
    if not isinstance(encoded, str) or len(encoded) > 8_000_000:
        raise ValueError("Embedded image exceeds the input limit")
    value = base64.b64decode(encoded, validate=True)
    with Image.open(io.BytesIO(value)) as image:
        image_size(image.size)
        if image.format not in {"PNG", "JPEG"}:
            raise ValueError("Use a PNG or JPEG image")
        fmt = image.format.lower()
        image.verify()
    return value, fmt


def word_text(node, text):
    if not isinstance(text, str) or len(text) > 20_000 or "\n" in text or "\r" in text:
        raise ValueError("Use one bounded line of text")
    node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    node.text = text


def word_paragraph(text):
    paragraph = XML.Element(tag(WORD, "p"))
    run = XML.SubElement(paragraph, tag(WORD, "r"))
    word_text(XML.SubElement(run, tag(WORD, "t")), text)
    return paragraph


def set_word_style(package, paragraph, style_id):
    styles = parse_xml(package.read("word/styles.xml"))
    if not any(style.get(tag(WORD, "styleId")) == style_id and style.get(tag(WORD, "type")) == "paragraph"
               for style in styles.findall(tag(WORD, "style"))):
        raise ValueError("Unknown paragraph style")
    props = xml_child(paragraph, WORD, "pPr", ("r", "hyperlink", "sdt"))
    style = xml_child(props, WORD, "pStyle", tuple(XML.QName(node).localname for node in props if isinstance(node.tag, str)))
    style.set(tag(WORD, "val"), style_id)


def word_block(body, operation, kind):
    block = body[bounded_integer(operation["blockIndex"], 0, len(body) - 1)]
    if block.tag != tag(WORD, kind):
        raise ValueError(f"Selected block is not a {kind}")
    return block


def add_word_media(package, replacements, additions, source, paragraph, operation):
    from docx import Document
    from docx.shared import Pt

    image, fmt = safe_image(operation["imageBase64"])
    width = bounded_integer(operation.get("widthPt", 144), 1, 1000)
    temporary = Document()
    run = temporary.add_paragraph().add_run()
    run.add_picture(io.BytesIO(image), width=Pt(width))
    drawing = deepcopy(run._element)
    rel = next(drawing.iter(tag(DRAWING, "blip")))
    destination = allocate_part(package, additions, "word/media/artifact-image", "." + fmt)
    rid = add_package_part(package, replacements, additions, source, destination, "image", f"image/{fmt}", image)
    rel.set(tag(OFFICE_REL, "embed"), rid)
    document = replacements[source]
    used = {node.get("id") for node in document.iter() if isinstance(node.tag, str) and XML.QName(node).localname == "docPr"}
    docpr = next(node for node in drawing.iter() if isinstance(node.tag, str) and XML.QName(node).localname == "docPr")
    docpr.set("id", next(str(i) for i in range(1, len(used) + 2) if str(i) not in used))
    paragraph.append(drawing)


PROTECTED_WORD_RUN_CHILDREN = {
    tag(WORD, name) for name in (
        "fldChar", "instrText", "drawing", "pict", "object",
        "footnoteReference", "endnoteReference", "commentReference",
    )
}
PROTECTED_WORD_PARA_CHILDREN = {
    tag(WORD, name) for name in (
        "hyperlink", "sdt", "fldSimple", "ins", "del", "smartTag", "customXml",
    )
}


def _word_ui_simple_paragraph(block):
    # UI rich editing applies only to ordinary text runs. Unknown XML,
    # hyperlinks, tabs, fields, bookmarks, tracked changes and drawings are
    # never rebuilt by the browser editor. Run identity is carried separately
    # so native formatting of mixed-style paragraphs survives edits.
    if block.tag != tag(WORD, "p") or any(child.tag not in {tag(WORD, "pPr"), tag(WORD, "r")} for child in block):
        return False
    runs = block.findall(tag(WORD, "r"))
    return all(
        child.tag in {tag(WORD, "rPr"), tag(WORD, "t"), tag(WORD, "br")}
        and (child.tag != tag(WORD, "br") or (child.get(tag(WORD, "type")) in (None, "textWrapping") and child.get(tag(WORD, "clear")) is None))
        and not any(node.tag == tag(WORD, "rPrChange") for node in child.iter())
        for r in runs for child in r
    )


def _word_ui_cell_paragraph(cell):
    paragraphs = cell.findall(tag(WORD, "p"))
    if len(paragraphs) != 1 or any(ch.tag not in {tag(WORD, "tcPr"), tag(WORD, "p")} for ch in cell):
        return None
    paragraph = paragraphs[0]
    properties = cell.find(tag(WORD, "tcPr"))
    if properties is not None and any(ch.tag in {tag(WORD, "gridSpan"), tag(WORD, "hMerge"), tag(WORD, "vMerge")} for ch in properties):
        return None
    return paragraph if _word_ui_simple_paragraph(paragraph) and len(paragraph.findall(tag(WORD, "r"))) <= 1 else None


def _word_ui_table_rows(table):
    rows = []
    for row in table.findall(tag(WORD, "tr")):
        cells = []
        for cell in row.findall(tag(WORD, "tc")):
            paragraph = _word_ui_cell_paragraph(cell)
            cells.append({
                "text": _word_ui_text(paragraph) if paragraph is not None else text_content(cell, WORD),
                "editable": paragraph is not None,
            })
        rows.append(cells)
    return rows


def _word_ui_numbering_formats(package):
    relations = package_relationships(package, MAIN_PART["docx"])
    part = next((part for kind, part in relations.values() if kind.endswith("/numbering")), None)
    if part is None or part not in package.namelist():
        return {}
    root = parse_xml(package.read(part))

    def level_formats(parent):
        formats = {}
        for level in parent.findall(tag(WORD, "lvl")):
            fmt = level.find(tag(WORD, "numFmt"))
            if fmt is not None:
                formats[level.get(tag(WORD, "ilvl"), "0")] = fmt.get(tag(WORD, "val"))
        return formats

    definitions = {
        definition.get(tag(WORD, "abstractNumId")): level_formats(definition)
        for definition in root.findall(tag(WORD, "abstractNum"))
    }
    result = {}
    for number in root.findall(tag(WORD, "num")):
        reference = number.find(tag(WORD, "abstractNumId"))
        formats = dict(definitions.get(reference.get(tag(WORD, "val")), {})) if reference is not None else {}
        for override in number.findall(tag(WORD, "lvlOverride")):
            formats.update(level_formats(override))
        result[number.get(tag(WORD, "numId"))] = formats
    return result


def _word_ui_paragraph_kind(paragraph, numbering_formats):
    if paragraph.tag != tag(WORD, "p"):
        return {}
    properties = paragraph.find(tag(WORD, "pPr"))
    if properties is None:
        return {}
    outline = properties.find(tag(WORD, "outlineLvl"))
    style = properties.find(tag(WORD, "pStyle"))
    match = re.fullmatch(r"heading([1-9])", style.get(tag(WORD, "val"), ""), re.I) if style is not None else None
    level = outline.get(tag(WORD, "val"), "") if outline is not None else ""
    result = {}
    if level.isdecimal() and int(level) < 9:
        result["headingLevel"] = int(level) + 1
    elif match:
        result["headingLevel"] = int(match[1])
    number = properties.find(tag(WORD, "numPr"))
    if number is not None:
        num_id = number.find(tag(WORD, "numId"))
        level = number.find(tag(WORD, "ilvl"))
        if num_id is not None:
            value = num_id.get(tag(WORD, "val"))
            result["listed"] = value != "0"
            fmt = numbering_formats.get(value, {}).get(level.get(tag(WORD, "val"), "0") if level is not None else "0")
            if result["listed"] and fmt in ("bullet", "decimal", "lowerLetter", "upperRoman"):
                result["listType"] = fmt
    return result


def _word_ui_marks(run):
    props = run.find(tag(WORD, "rPr"))
    result = {}
    if props is not None:
        for name, element in (("bold", "b"), ("italic", "i"), ("underline", "u")):
            el = props.find(tag(WORD, element))
            if el is not None:
                result[name] = el.get(tag(WORD, "val"), "1") not in ("0", "false", "off", "none")
    return result


def _word_ui_run_text(run):
    return "".join((node.text or "") if node.tag == tag(WORD, "t") else "\n"
                   for node in run if node.tag in (tag(WORD, "t"), tag(WORD, "br")))


def _word_ui_text(block):
    return "".join(_word_ui_run_text(run) for run in block.findall(tag(WORD, "r")))


def _word_ui_runs(block):
    return [{"originIndex": i, "text": _word_ui_run_text(run), **_word_ui_marks(run)}
            for i, run in enumerate(block.findall(tag(WORD, "r")))] or [{"originIndex": 0, "text": ""}]


def _apply_word_run_props(run, spec):
    props = xml_child(run, WORD, "rPr", ("t", "br", "tab"))
    trailing = ("color", "spacing", "w", "kern", "position", "sz", "szCs", "highlight", "u", "shd", "vertAlign", "lang", "rPrChange")
    if "fontFamily" in spec and spec["fontFamily"]:
        font = str(spec["fontFamily"])[:128]
        fonts = xml_child(props, WORD, "rFonts", ("b", "bCs", "i", "iCs", "strike") + trailing)
        for field in ("ascii", "hAnsi", "eastAsia", "cs"):
            fonts.set(tag(WORD, field), font)
    for option, element in (("bold", "b"), ("italic", "i"), ("strike", "strike")):
        if option in spec:
            before = (("i", "iCs", "strike") if option == "bold" else (("strike",) if option == "italic" else ())) + trailing
            xml_child(props, WORD, element, before).set(tag(WORD, "val"), "1" if spec[option] is True else "0")
    color_val = spec.get("color", spec.get("fontColor"))
    if color_val is not None:
        cleaned = str(color_val).lstrip("#")
        if not re.fullmatch(r"[0-9A-Fa-f]{6}", cleaned):
            raise ValueError("Use a six-digit RGB color")
        node = xml_child(props, WORD, "color", trailing[1:])
        node.attrib.clear()
        node.set(tag(WORD, "val"), cleaned.upper())
    if "fontSizePt" in spec:
        half_pt = str(bounded_integer(round(float(spec["fontSizePt"]) * 2), 2, 800))
        xml_child(props, WORD, "sz", ("szCs", "highlight", "u", "shd", "vertAlign", "lang", "rPrChange")).set(tag(WORD, "val"), half_pt)
        xml_child(props, WORD, "szCs", ("highlight", "u", "shd", "vertAlign", "lang", "rPrChange")).set(tag(WORD, "val"), half_pt)
    if "highlight" in spec:
        hl = str(spec["highlight"])
        allowed_hl = {"yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan",
                      "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray", "black", "white", "none"}
        if hl not in allowed_hl:
            raise ValueError(f"Unsupported highlight color: {hl}")
        xml_child(props, WORD, "highlight", ("u", "shd", "vertAlign", "lang", "rPrChange")).set(tag(WORD, "val"), hl)
    if "underline" in spec:
        u_val = "single" if spec["underline"] is True else ("none" if spec["underline"] is False else str(spec["underline"]))
        if u_val not in {"single", "double", "thick", "dotted", "dash", "wave", "none"}:
            raise ValueError(f"Unsupported underline style: {u_val}")
        xml_child(props, WORD, "u", ("shd", "vertAlign", "lang", "rPrChange")).set(tag(WORD, "val"), u_val)
    if "shading" in spec or "backgroundColor" in spec:
        bg = str(spec.get("shading", spec.get("backgroundColor"))).lstrip("#")
        if not re.fullmatch(r"[0-9A-Fa-f]{6}", bg):
            raise ValueError("Use a six-digit RGB color")
        shd = xml_child(props, WORD, "shd", ("vertAlign", "lang", "rPrChange"))
        shd.set(tag(WORD, "val"), "clear")
        shd.set(tag(WORD, "color"), "auto")
        shd.set(tag(WORD, "fill"), bg.upper())
    if "vertAlign" in spec:
        va = str(spec["vertAlign"])
        if va not in {"baseline", "superscript", "subscript"}:
            raise ValueError(f"Unsupported vertAlign: {va}")
        xml_child(props, WORD, "vertAlign", ("lang", "rPrChange")).set(tag(WORD, "val"), va)


def _set_run_multiline_text(run, text):
    for child in list(run):
        if child.tag in {tag(WORD, "t"), tag(WORD, "br")}:
            run.remove(child)
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for idx, segment in enumerate(lines):
        if idx > 0:
            XML.SubElement(run, tag(WORD, "br"))
        t = XML.SubElement(run, tag(WORD, "t"))
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        t.text = segment


def _read_word_styles_readonly(package, replacements, additions):
    part = "word/styles.xml"
    if part in replacements:
        return replacements[part]
    if part in additions:
        val = additions[part]
        return parse_xml(val) if isinstance(val, (bytes, bytearray)) else val
    return parse_xml(package.read(part))


def _ensure_word_heading_style(package, replacements, additions, style_id):
    m = re.fullmatch(r"Heading([1-9])", str(style_id))
    if not m:
        return
    part = "word/styles.xml"
    if part not in package.namelist() and part not in additions:
        return
    ro_styles = _read_word_styles_readonly(package, replacements, additions)
    if any(n.get(tag(WORD, "styleId")) == style_id for n in ro_styles.findall(tag(WORD, "style"))):
        return
    styles = load_edit_part(package, replacements, additions, part)
    level = int(m.group(1))
    sizes_half_pt = {1: 32, 2: 26, 3: 24, 4: 22, 5: 20, 6: 20, 7: 20, 8: 20, 9: 20}
    style_el = XML.SubElement(styles, tag(WORD, "style"))
    style_el.set(tag(WORD, "type"), "paragraph")
    style_el.set(tag(WORD, "styleId"), style_id)
    XML.SubElement(style_el, tag(WORD, "name")).set(tag(WORD, "val"), f"heading {level}")
    ppr = XML.SubElement(style_el, tag(WORD, "pPr"))
    XML.SubElement(ppr, tag(WORD, "keepNext"))
    XML.SubElement(ppr, tag(WORD, "outlineLvl")).set(tag(WORD, "val"), str(level - 1))
    rpr = XML.SubElement(style_el, tag(WORD, "rPr"))
    XML.SubElement(rpr, tag(WORD, "b"))
    XML.SubElement(rpr, tag(WORD, "sz")).set(tag(WORD, "val"), str(sizes_half_pt[level]))
    XML.SubElement(rpr, tag(WORD, "szCs")).set(tag(WORD, "val"), str(sizes_half_pt[level]))


def _apply_word_paragraph_props(package, replacements, additions, paragraph, operation):
    ppr = xml_child(paragraph, WORD, "pPr", ("r", "hyperlink", "sdt", "bookmarkStart", "bookmarkEnd"))
    if "styleId" in operation and operation["styleId"]:
        _ensure_word_heading_style(package, replacements, additions, operation["styleId"])
        styles = _read_word_styles_readonly(package, replacements, additions)
        style_id = str(operation["styleId"])
        if not any(n.get(tag(WORD, "type")) == "paragraph" and n.get(tag(WORD, "styleId")) == style_id
                   for n in styles.findall(tag(WORD, "style"))):
            raise ValueError(f"Unknown paragraph style: {style_id}")
        xml_child(ppr, WORD, "pStyle", ("keepNext", "keepLines", "pageBreakBefore", "numPr", "pBdr", "shd", "spacing", "ind", "jc")).set(
            tag(WORD, "val"), style_id
        )
    if "headingLevel" in operation:
        heading_level = bounded_integer(operation["headingLevel"], 0, 9)
        outline = ppr.find(tag(WORD, "outlineLvl"))
        if heading_level == 0:
            paragraph_style = ppr.find(tag(WORD, "pStyle"))
            if paragraph_style is not None:
                ppr.remove(paragraph_style)
            if outline is not None:
                ppr.remove(outline)
        else:
            h_id = f"Heading{heading_level}"
            if outline is not None:
                outline.set(tag(WORD, "val"), str(heading_level - 1))
            _ensure_word_heading_style(package, replacements, additions, h_id)
            xml_child(ppr, WORD, "pStyle", ("keepNext", "keepLines", "pageBreakBefore", "numPr", "pBdr", "shd", "spacing", "ind", "jc")).set(
                tag(WORD, "val"), h_id
            )
    for flag_key, el_name, before in (
        ("keepNext", "keepNext", ("keepLines", "pageBreakBefore", "numPr", "pBdr", "shd", "spacing", "ind", "jc")),
        ("keepLines", "keepLines", ("pageBreakBefore", "numPr", "pBdr", "shd", "spacing", "ind", "jc")),
        ("pageBreakBefore", "pageBreakBefore", ("numPr", "pBdr", "shd", "spacing", "ind", "jc")),
    ):
        if flag_key in operation:
            existing = ppr.find(tag(WORD, el_name))
            if operation[flag_key]:
                if existing is None:
                    xml_child(ppr, WORD, el_name, before)
            elif existing is not None:
                ppr.remove(existing)
    if isinstance(operation.get("borders"), dict):
        pbdr = xml_child(ppr, WORD, "pBdr", ("shd", "spacing", "ind", "jc"))
        for side in ("top", "bottom", "left", "right"):
            cfg = operation["borders"].get(side)
            if not isinstance(cfg, dict):
                continue
            b_el = xml_child(pbdr, WORD, side)
            b_el.set(tag(WORD, "val"), str(cfg.get("style", "single")))
            b_el.set(tag(WORD, "sz"), str(bounded_integer(round(float(cfg.get("sizePt", 0.75)) * 8), 2, 96)))
            b_el.set(tag(WORD, "space"), "4")
            b_el.set(tag(WORD, "color"), str(cfg.get("color", "000000")).lstrip("#").upper())
    bg = operation.get("backgroundColor", operation.get("shading"))
    if bg is not None:
        cleaned = str(bg).lstrip("#")
        if not re.fullmatch(r"[0-9A-Fa-f]{6}", cleaned):
            raise ValueError("Use a six-digit RGB color")
        shd = xml_child(ppr, WORD, "shd", ("spacing", "ind", "jc"))
        shd.set(tag(WORD, "val"), "clear")
        shd.set(tag(WORD, "color"), "auto")
        shd.set(tag(WORD, "fill"), cleaned.upper())
    if any(k in operation for k in ("spaceBeforePt", "spaceAfterPt", "lineSpacing")):
        sp = xml_child(ppr, WORD, "spacing", ("ind", "jc"))
        if "spaceBeforePt" in operation:
            sp.set(tag(WORD, "before"), str(bounded_integer(round(float(operation["spaceBeforePt"]) * 20), 0, 14400)))
        if "spaceAfterPt" in operation:
            sp.set(tag(WORD, "after"), str(bounded_integer(round(float(operation["spaceAfterPt"]) * 20), 0, 14400)))
        if "lineSpacing" in operation:
            ls = float(operation["lineSpacing"])
            if not math.isfinite(ls) or not 0.5 <= ls <= 10.0:
                raise ValueError("lineSpacing multiplier must be between 0.5 and 10")
            sp.set(tag(WORD, "line"), str(int(round(ls * 240))))
            sp.set(tag(WORD, "lineRule"), "auto")
    if any(k in operation for k in ("indentLeftPt", "indentRightPt", "firstLineIndentPt", "hangingIndentPt")):
        ind = xml_child(ppr, WORD, "ind", ("jc",))
        for key, attr in (
            ("indentLeftPt", "left"), ("indentRightPt", "right"),
            ("firstLineIndentPt", "firstLine"), ("hangingIndentPt", "hanging"),
        ):
            if key in operation:
                ind.set(tag(WORD, attr), str(bounded_integer(round(float(operation[key]) * 20), 0, 14400)))
    if "alignment" in operation:
        al = str(operation["alignment"])
        al_map = {"left": "left", "center": "center", "right": "right", "justify": "both", "both": "both"}
        if al not in al_map:
            raise ValueError(f"Unsupported paragraph alignment: {al}")
        xml_child(ppr, WORD, "jc").set(tag(WORD, "val"), al_map[al])


def _ensure_word_numbering_definition(package, replacements, additions, list_type):
    part = "word/numbering.xml"
    if part not in package.namelist() and part not in additions:
        root = XML.Element(tag(WORD, "numbering"), nsmap={"w": WORD})
        add_package_part(
            package, replacements, additions, MAIN_PART["docx"], part, "numbering",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
            XML.tostring(root),
        )
    numbering = load_edit_part(package, replacements, additions, part)
    fmt_map = {
        "bullet": ("bullet", "•"),
        "decimal": ("decimal", "%1."),
        "lowerLetter": ("lowerLetter", "%1)"),
        "upperRoman": ("upperRoman", "%1."),
    }
    if list_type not in fmt_map:
        raise ValueError(f"Unsupported listType: {list_type}")
    num_fmt, lvl_text = fmt_map[list_type]

    existing_abstracts = [int(n.get(tag(WORD, "abstractNumId"), "0")) for n in numbering.findall(tag(WORD, "abstractNum"))]
    existing_nums = [int(n.get(tag(WORD, "numId"), "0")) for n in numbering.findall(tag(WORD, "num"))]
    abs_id = str(max([-1] + existing_abstracts) + 1)
    num_id = str(max([0] + existing_nums) + 1)

    abs_el = XML.Element(tag(WORD, "abstractNum"))
    abs_el.set(tag(WORD, "abstractNumId"), abs_id)
    for lvl in range(9):
        lvl_el = XML.SubElement(abs_el, tag(WORD, "lvl"))
        lvl_el.set(tag(WORD, "ilvl"), str(lvl))
        XML.SubElement(lvl_el, tag(WORD, "start")).set(tag(WORD, "val"), "1")
        XML.SubElement(lvl_el, tag(WORD, "numFmt")).set(tag(WORD, "val"), num_fmt)
        XML.SubElement(lvl_el, tag(WORD, "lvlText")).set(tag(WORD, "val"), lvl_text if list_type == "bullet" else f"%{lvl + 1}.")
        XML.SubElement(lvl_el, tag(WORD, "lvlJc")).set(tag(WORD, "val"), "left")
        ppr = XML.SubElement(lvl_el, tag(WORD, "pPr"))
        ind = XML.SubElement(ppr, tag(WORD, "ind"))
        ind.set(tag(WORD, "left"), str((lvl + 1) * 720))
        ind.set(tag(WORD, "hanging"), "360")
    first_num = numbering.find(tag(WORD, "num"))
    if first_num is not None:
        numbering.insert(list(numbering).index(first_num), abs_el)
    else:
        numbering.append(abs_el)

    num_el = XML.SubElement(numbering, tag(WORD, "num"))
    num_el.set(tag(WORD, "numId"), num_id)
    XML.SubElement(num_el, tag(WORD, "abstractNumId")).set(tag(WORD, "val"), abs_id)
    return num_id


def add_word_header_footer(package, replacements, additions, body, operation):
    kind = operation["kind"]
    variant = operation.get("variant", "default")
    if kind not in {"header", "footer"} or variant not in {"default", "first", "even"}:
        raise ValueError("Invalid header or footer type")
    sections = list(body.iter(tag(WORD, "sectPr")))
    if not sections:
        raise ValueError("Document has no section")
    sec_idx = bounded_integer(operation.get("sectionIndex", len(sections) - 1), 0, len(sections) - 1)
    section = sections[sec_idx]
    ref_tag = tag(WORD, kind + "Reference")
    existing_ref = next((node for node in section.findall(ref_tag) if node.get(tag(WORD, "type")) == variant), None)
    if existing_ref is not None:
        if not operation.get("overwrite"):
            raise ValueError("The selected header or footer already exists")
        rels = package_relationships(package, MAIN_PART["docx"])
        rid = existing_ref.get(tag(OFFICE_REL, "id"))
        if rid in rels:
            part_path = rels[rid][1]
            existing_root = load_edit_part(package, replacements, additions, part_path)
            for child in list(existing_root):
                existing_root.remove(child)
            existing_root.append(word_paragraph(operation["text"]))
            return
    root = XML.Element(tag(WORD, "hdr" if kind == "header" else "ftr"), nsmap={"w": WORD})
    root.append(word_paragraph(operation["text"]))
    name = allocate_part(package, additions, "word/" + kind, ".xml")
    rid = add_package_part(package, replacements, additions, MAIN_PART["docx"], name, kind,
                           f"application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml",
                           XML.tostring(root))
    reference = XML.Element(ref_tag)
    reference.set(tag(WORD, "type"), variant)
    reference.set(tag(OFFICE_REL, "id"), rid)
    offset = sum(node.tag == tag(WORD, "headerReference") for node in section) if kind == "footer" else 0
    section.insert(offset, reference)
    if variant == "first":
        xml_child(section, WORD, "titlePg", ("textDirection", "bidi", "rtlGutter", "docGrid", "sectPrChange"))
    if variant == "even":
        settings = load_edit_part(package, replacements, additions, "word/settings.xml")
        xml_child(settings, WORD, "evenAndOddHeaders", ("bookFoldRevPrinting", "bookFoldPrinting", "defaultTableStyle",
                                                       "characterSpacingControl", "compat", "docVars", "rsids"))


def add_word_footnote(package, replacements, additions, body, operation):
    paragraph = word_block(body, operation, "p")
    part = "word/footnotes.xml"
    if part not in package.namelist() and part not in additions:
        root = XML.Element(tag(WORD, "footnotes"), nsmap={"w": WORD})
        add_package_part(package, replacements, additions, MAIN_PART["docx"], part, "footnotes",
                         "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
                         XML.tostring(root))
    root = load_edit_part(package, replacements, additions, part)
    identifier = str(max([0] + [int(node.get(tag(WORD, "id"), "0")) for node in root]) + 1)
    note = XML.SubElement(root, tag(WORD, "footnote"))
    note.set(tag(WORD, "id"), identifier)
    contents = word_paragraph(operation["text"])
    mark = XML.Element(tag(WORD, "r"))
    XML.SubElement(mark, tag(WORD, "footnoteRef"))
    contents.insert(0, mark)
    note.append(contents)
    mark = XML.SubElement(XML.SubElement(paragraph, tag(WORD, "r")), tag(WORD, "footnoteReference"))
    mark.set(tag(WORD, "id"), identifier)


def _apply_word_list(package, replacements, additions, paragraph, operation):
    if operation.get("listType") == "none" or operation.get("enabled") is False:
        ppr = paragraph.find(tag(WORD, "pPr"))
        if ppr is not None:
            old_num = ppr.find(tag(WORD, "numPr"))
            if old_num is not None:
                ppr.remove(old_num)
        return
    if "listType" in operation:
        number = _ensure_word_numbering_definition(package, replacements, additions, operation["listType"])
    else:
        numbering = load_edit_part(package, replacements, additions, "word/numbering.xml")
        number = str(bounded_integer(operation["numberingId"], 1, 65535))
        if not any(node.get(tag(WORD, "numId")) == number for node in numbering.findall(tag(WORD, "num"))):
            raise ValueError("Unknown numbering definition")
    props = xml_child(paragraph, WORD, "pPr", ("r", "hyperlink", "sdt"))
    num = xml_child(props, WORD, "numPr", ("suppressLineNumbers", "pBdr", "shd", "tabs", "spacing", "ind", "jc"))
    xml_child(num, WORD, "ilvl", ("numId",)).set(tag(WORD, "val"), str(bounded_integer(operation.get("level", 0), 0, 8)))
    xml_child(num, WORD, "numId").set(tag(WORD, "val"), number)


def word_edit_extra(package, replacements, additions, body, operation):
    source = MAIN_PART["docx"]
    op = operation["op"]
    if op == "docx.add_paragraph":
        if isinstance(operation.get("runs"), list) and operation["runs"]:
            paragraph = XML.Element(tag(WORD, "p"))
            for r_spec in operation["runs"]:
                run = XML.SubElement(paragraph, tag(WORD, "r"))
                _apply_word_run_props(run, r_spec)
                _set_run_multiline_text(run, r_spec.get("text", ""))
        else:
            paragraph = word_paragraph(operation.get("text", ""))
        if any(k in operation for k in ("styleId", "headingLevel", "alignment", "spaceBeforePt", "spaceAfterPt",
                                        "lineSpacing", "indentLeftPt", "indentRightPt", "firstLineIndentPt",
                                        "hangingIndentPt", "backgroundColor", "shading", "borders",
                                        "keepNext", "keepLines", "pageBreakBefore")):
            _apply_word_paragraph_props(package, replacements, additions, paragraph, operation)
        if "listType" in operation:
            _apply_word_list(package, replacements, additions, paragraph, operation)
        section = body.find(tag(WORD, "sectPr"))
        max_pos = body.index(section) if section is not None else len(body)
        insert_at = bounded_integer(operation.get("insertAt", max_pos), 0, max_pos)
        body.insert(insert_at, paragraph)
    elif op == "docx.remove_paragraph":
        block = word_block(body, operation, "p")
        if len([ch for ch in body if ch.tag in {tag(WORD, "p"), tag(WORD, "tbl")}]) <= 1:
            raise ValueError("Document must retain at least one body block")
        body.remove(block)
    elif op == "docx.set_paragraph_style":
        _apply_word_paragraph_props(package, replacements, additions, word_block(body, operation, "p"), operation)
    elif op == "docx.set_run_style":
        block = word_block(body, operation, "p")
        runs = block.findall(tag(WORD, "r"))
        if not runs:
            raise ValueError("Paragraph contains no runs")
        if "runIndex" in operation:
            targets = [runs[bounded_integer(operation["runIndex"], 0, len(runs) - 1)]]
        else:
            targets = [r for r in runs if r.findall(tag(WORD, "t")) and not any(ch.tag in PROTECTED_WORD_RUN_CHILDREN for ch in r)]
            if not targets:
                raise ValueError("Paragraph has no unprotected text runs")
        for run in targets:
            if not run.findall(tag(WORD, "t")) or any(node.tag not in {tag(WORD, "t"), tag(WORD, "rPr"), tag(WORD, "br"), tag(WORD, "tab")} for node in run):
                raise ValueError("Select an unprotected text run")
            _apply_word_run_props(run, operation)
    elif op == "docx.set_list":
        _apply_word_list(package, replacements, additions, word_block(body, operation, "p"), operation)
    elif op == "docx.add_table":
        from docx import Document
        rows = operation["rows"]
        columns = len(rows[0]) if rows else 0
        if not 1 <= len(rows) <= 100 or not 1 <= columns <= 30 or any(len(row) != columns for row in rows):
            raise ValueError("Expected a bounded rectangular table")
        temporary = Document()
        table = temporary.add_table(rows=len(rows), cols=columns)
        for i, row in enumerate(rows):
            for j, value in enumerate(row):
                word_text(XML.SubElement(XML.SubElement(table.cell(i, j).paragraphs[0]._p, tag(WORD, "r")), tag(WORD, "t")), str(value))
        section = body.find(tag(WORD, "sectPr"))
        body.insert(body.index(section) if section is not None else len(body), deepcopy(table._tbl))
    elif op == "docx.set_table_cell":
        table = word_block(body, operation, "tbl")
        rows = table.findall(tag(WORD, "tr"))
        row = rows[bounded_integer(operation["row"], 0, len(rows) - 1)]
        cells = row.findall(tag(WORD, "tc"))
        cell = cells[bounded_integer(operation["column"], 0, len(cells) - 1)]
        if any(ch.tag in PROTECTED_WORD_PARA_CHILDREN for p in cell.findall(tag(WORD, "p")) for ch in p):
            raise ValueError("Table cell contains protected content")
        if any(ch.tag in PROTECTED_WORD_RUN_CHILDREN for r in cell.iter(tag(WORD, "r")) for ch in r):
            raise ValueError("Table cell contains protected inline objects")
        if "text" in operation and operation.get("preserveCellProperties") is True:
            paragraph = _word_ui_cell_paragraph(cell)
            if paragraph is None or not isinstance(operation["text"], str):
                raise ValueError("Select a simple text cell")
            run = paragraph.find(tag(WORD, "r"))
            if run is None:
                run = XML.SubElement(paragraph, tag(WORD, "r"))
            _set_run_multiline_text(run, operation["text"])
        elif "text" in operation:
            existing_paras = cell.findall(tag(WORD, "p"))
            first_ppr = deepcopy(existing_paras[0].find(tag(WORD, "pPr"))) if existing_paras and existing_paras[0].find(tag(WORD, "pPr")) is not None else None
            first_run = existing_paras[0].find(tag(WORD, "r")) if existing_paras else None
            first_rpr = deepcopy(first_run.find(tag(WORD, "rPr"))) if first_run is not None and first_run.find(tag(WORD, "rPr")) is not None else None
            for old_p in existing_paras:
                cell.remove(old_p)
            lines = str(operation["text"])[:20_000].split("\n")
            for line_text in lines:
                new_p = XML.SubElement(cell, tag(WORD, "p"))
                if first_ppr is not None:
                    new_p.append(deepcopy(first_ppr))
                new_r = XML.SubElement(new_p, tag(WORD, "r"))
                if first_rpr is not None:
                    new_r.append(deepcopy(first_rpr))
                word_text(XML.SubElement(new_r, tag(WORD, "t")), line_text)
        if any(k in operation for k in ("backgroundColor", "shading", "verticalAlign", "widthPt")):
            tcpr = xml_child(cell, WORD, "tcPr", ("p", "tbl"))
            if "widthPt" in operation:
                tcw = xml_child(tcpr, WORD, "tcW", ("shd", "vAlign"))
                tcw.set(tag(WORD, "w"), str(bounded_integer(round(float(operation["widthPt"]) * 20), 60, 28800)))
                tcw.set(tag(WORD, "type"), "dxa")
            bg = operation.get("backgroundColor", operation.get("shading"))
            if bg is not None:
                cleaned = str(bg).lstrip("#")
                if not re.fullmatch(r"[0-9A-Fa-f]{6}", cleaned):
                    raise ValueError("Use a six-digit RGB color")
                shd = xml_child(tcpr, WORD, "shd", ("vAlign",))
                shd.set(tag(WORD, "val"), "clear")
                shd.set(tag(WORD, "color"), "auto")
                shd.set(tag(WORD, "fill"), cleaned.upper())
            if "verticalAlign" in operation:
                va = str(operation["verticalAlign"])
                if va not in {"top", "center", "bottom"}:
                    raise ValueError("Invalid table cell verticalAlign")
                xml_child(tcpr, WORD, "vAlign").set(tag(WORD, "val"), va)
        if any(k in operation for k in ("bold", "italic", "underline", "strike", "fontSizePt", "color", "fontColor", "fontFamily")):
            for r in cell.findall("./" + tag(WORD, "p") + "/" + tag(WORD, "r")):
                _apply_word_run_props(r, operation)
        if "alignment" in operation:
            for p in cell.findall(tag(WORD, "p")):
                _apply_word_paragraph_props(package, replacements, additions, p, {"alignment": operation["alignment"]})
    elif op == "docx.add_image":
        add_word_media(package, replacements, additions, source, word_block(body, operation, "p"), operation)
    elif op == "docx.add_header_footer":
        add_word_header_footer(package, replacements, additions, body, operation)
    elif op == "docx.add_footnote":
        add_word_footnote(package, replacements, additions, body, operation)
    elif op == "docx.patch_xml_text":
        paragraph = word_block(body, operation, "p")
        texts = paragraph.findall("./" + tag(WORD, "r") + "/" + tag(WORD, "t"))
        text = texts[bounded_integer(operation["textIndex"], 0, len(texts) - 1)]
        if (text.text or "") != operation["expectedText"]:
            raise ValueError("Selected XML text no longer matches")
        word_text(text, operation["text"])
    elif op in {"docx.edit_header_footer", "docx.edit_footnote"}:
        part = operation["part"]
        pattern = r"word/(?:header|footer)[0-9]+\.xml" if op == "docx.edit_header_footer" else r"word/footnotes\.xml"
        if not re.fullmatch(pattern, part):
            raise ValueError("Invalid Word related part")
        root = load_edit_part(package, replacements, additions, part)
        if op == "docx.edit_footnote":
            identifier = str(bounded_integer(operation["footnoteId"], 1, 65535))
            root = next((note for note in root if note.get(tag(WORD, "id")) == identifier), None)
            if root is None:
                raise ValueError("Unknown footnote")
        if "textIndex" in operation:
            texts = root.findall("./" + tag(WORD, "p") + "/" + tag(WORD, "r") + "/" + tag(WORD, "t"))
            word_text(texts[bounded_integer(operation["textIndex"], 0, len(texts) - 1)], operation["text"])
        else:
            paras = root.findall(tag(WORD, "p"))
            if not paras:
                root.append(word_paragraph(operation["text"]))
            else:
                p = paras[bounded_integer(operation.get("paragraphIndex", 0), 0, len(paras) - 1)]
                text_runs = [r for r in p.findall(tag(WORD, "r")) if r.find(tag(WORD, "t")) is not None and not any(ch.tag in PROTECTED_WORD_RUN_CHILDREN for ch in r)]
                if not text_runs:
                    new_r = XML.SubElement(p, tag(WORD, "r"))
                    _set_run_multiline_text(new_r, operation["text"])
                else:
                    _set_run_multiline_text(text_runs[0], operation["text"])
                    for extra_r in text_runs[1:]:
                        p.remove(extra_r)
    else:
        raise ValueError("Unsupported Word operation")


def edit_word(package, operations, output):
    main_part = MAIN_PART["docx"]
    document = parse_xml(package.read(main_part))
    body = document.find(tag(WORD, "body"))
    replacements = {main_part: document}
    additions = {}
    for operation in operations:
        op = operation["op"]
        if op == "docx.set_paragraph_text":
            index = bounded_integer(operation["blockIndex"], 0, len(body) - 1)
            block = body[index]
            if block.tag != tag(WORD, "p"):
                raise ValueError("Only paragraphs support this edit")
            if any(child.tag in PROTECTED_WORD_PARA_CHILDREN for child in block):
                raise ValueError("Paragraph contains protected content")
            runs = block.findall(tag(WORD, "r"))
            if any(node.tag in PROTECTED_WORD_RUN_CHILDREN for r in runs for node in r):
                raise ValueError("Paragraph contains protected inline content")
            if operation.get("preserveRunProperties") is True:
                # This is an opt-in guarded UI operation, not a general
                # replacement of arbitrary rich Word paragraphs.
                if not _word_ui_simple_paragraph(block):
                    raise ValueError("Paragraph has protected content")
                specs = operation.get("runs")
                if not isinstance(specs, list) or not specs or any(
                    not isinstance(spec, dict) or not isinstance(spec.get("text"), str)
                    or set(spec) - {"text", "originIndex", "bold", "italic", "underline"}
                    or type(spec.get("originIndex", 0)) is not int
                    or not 0 <= spec.get("originIndex", 0) < max(1, len(runs))
                    or any(not isinstance(spec[k], bool) for k in ("bold", "italic", "underline") if k in spec)
                    for spec in specs
                ):
                    raise ValueError("Invalid simple paragraph runs")
                for old_r in runs:
                    block.remove(old_r)
                for spec in specs:
                    origin = runs[spec.get("originIndex", 0)] if runs else None
                    new_r = deepcopy(origin) if origin is not None else XML.Element(tag(WORD, "r"))
                    block.append(new_r)
                    changes = {k: v for k, v in spec.items() if k not in ("text", "originIndex")}
                    if changes:
                        _apply_word_run_props(new_r, changes)
                    if origin is None or spec["text"] != _word_ui_run_text(origin):
                        _set_run_multiline_text(new_r, spec["text"])
            elif isinstance(operation.get("runs"), list) and operation["runs"]:
                for old_r in runs:
                    block.remove(old_r)
                for r_spec in operation["runs"][:200]:
                    new_r = XML.SubElement(block, tag(WORD, "r"))
                    _apply_word_run_props(new_r, r_spec)
                    _set_run_multiline_text(new_r, r_spec.get("text", ""))
            elif "runIndex" in operation:
                if not runs:
                    raise ValueError("Paragraph contains no runs")
                target_run = runs[bounded_integer(operation["runIndex"], 0, len(runs) - 1)]
                _set_run_multiline_text(target_run, operation["text"])
            else:
                text = str(operation["text"])
                if len(text) > 20_000:
                    raise ValueError("Paragraph text exceeds length limit")
                if not runs:
                    new_r = XML.SubElement(block, tag(WORD, "r"))
                    _set_run_multiline_text(new_r, text)
                else:
                    first_run = runs[0]
                    _set_run_multiline_text(first_run, text)
                    for extra in runs[1:]:
                        block.remove(extra)
        elif op in {"docx.set_page_size", "docx.set_page_layout"}:
            update_word_page_layout(body, operation)
        else:
            word_edit_extra(package, replacements, additions, body, operation)
    serialize_additions(package, replacements, additions, output, "docx")


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


def set_chart_cache(cache, values):
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


def update_chart_categories(series, all_series, categories):
    path = "./" + tag(CHART, "cat") + "/*"
    incoming = [node for node in series.findall(path) if node.tag in (tag(CHART, "strRef"), tag(CHART, "numRef"))]
    if len(incoming) != 1:
        raise ValueError("Expected worksheet-backed chart categories")
    formula = incoming[0].findtext(tag(CHART, "f"))
    for item in all_series:
        for reference in item.findall(path):
            if reference.tag not in (tag(CHART, "strRef"), tag(CHART, "numRef")) \
                    or reference.findtext(tag(CHART, "f")) != formula:
                continue
            if reference.tag == tag(CHART, "numRef"):
                text_ref = XML.Element(tag(CHART, "strRef"))
                XML.SubElement(text_ref, tag(CHART, "f")).text = formula
                reference.getparent().replace(reference, text_ref)
                reference = text_ref
            cache = reference.find(tag(CHART, "strCache"))
            if cache is None:
                cache = XML.SubElement(reference, tag(CHART, "strCache"))
            set_chart_cache(cache, categories)
    return formula


def update_chart_values(package, fmt, chart_part, series, operation, replacements, all_series):
    formula, cache = chart_value_cache(series)
    values = operation["values"]
    if not isinstance(values, list) or not 1 <= len(values) <= 1000 or any(
            type(value) not in (float, int) or not math.isfinite(value) for value in values):
        raise ValueError("Chart values must be finite numbers")
    ranges = [(formula, values)]
    if "categories" in operation:
        categories = operation["categories"]
        if not isinstance(categories, list) or len(categories) != len(values) or any(
                not isinstance(value, str) or len(value) > 2000 for value in categories):
            raise ValueError("Chart categories must be text and match the series length")
        category_formula = update_chart_categories(series, all_series, categories)
        if category_formula == formula:
            raise ValueError("Chart categories and values cannot share a worksheet range")
        ranges.append((category_formula, categories))

    def changes_for(workbook):
        changes = [change for source_formula, cells in ranges
                   for change in chart_cell_updates(workbook, source_formula, cells)]
        addresses = {(change["sheetPart"], change["address"]) for change in changes}
        if len(addresses) != len(changes):
            raise ValueError("Chart category and value ranges overlap")
        return changes

    if fmt == "xlsx":
        for change in changes_for(package):
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
            edit_workbook(embedded, changes_for(embedded), output)
            replacements[embed[0]] = output.getvalue()
    set_chart_cache(cache, values)


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
    update_chart_values(package, fmt, chart_part, template, operation, replacements, [*all_series, template])
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
            update_chart_values(package, fmt, chart_part, series, operation, replacements, all_series)
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


SMARTART_SUPPORTED_LINEAR_LIST_RE = re.compile(
    r"(?:^|/)(?:default|vList[0-9]*|hList[0-9]*|bList[0-9]*|lList[0-9]*|list[0-9]*)$", re.I
)
SMARTART_SUPPORTED_LINEAR_PROCESS_RE = re.compile(
    r"(?:^|/)(?:process[0-9]*|chevron[0-9]*|arrow[0-9]*|lProcess[0-9]*|vProcess[0-9]*|hProcess[0-9]*)$", re.I
)
SMARTART_ORDINAL_PRES_NAME_RE = re.compile(r"^([A-Za-z_]+?)(\d+)([A-Za-z_]*)$")


def _smartart_layout_ch_max(layout_root):
    """Return top-level chMax constraint from layoutDef varLst if positive, else None."""
    if layout_root is None:
        return None
    root_ln = layout_root.find(tag(DIAGRAM, "layoutNode"))
    if root_ln is None:
        return None
    var_lst = root_ln.find(tag(DIAGRAM, "varLst"))
    if var_lst is None:
        return None
    ch_max_el = var_lst.find(tag(DIAGRAM, "chMax"))
    if ch_max_el is None:
        return None
    try:
        val = int(ch_max_el.get("val", "-1"))
        return val if val > 0 else None
    except ValueError:
        return None


def _smartart_layout_has_computable_atoms(layout_root):
    """Return True if layoutDef declares DrawingML layout algorithms executable by LibreOffice."""
    if layout_root is None:
        return False
    algs = [el.get("type") for el in layout_root.iter(tag(DIAGRAM, "alg")) if el.get("type")]
    computable = {"lin", "cycle", "pyra", "snake", "composite", "hierRoot", "hierChild", "conn", "sp", "tx"}
    return any(a in computable for a in algs)


def classify_smartart_layout(data_root, drawing_root=None, layout_root=None):
    """Classify a SmartArt layout and determine add/remove node capability using layoutDef + LibreOffice or 1D linear reflow."""
    lo_type = next(
        (node.get("loTypeId") for node in data_root.iter(tag(DIAGRAM, "prSet")) if node.get("loTypeId")),
        None,
    )
    if not lo_type and layout_root is not None:
        lo_type = layout_root.get("uniqueId")
    short_id = lo_type.rsplit("/", 1)[-1] if lo_type else "unknown"
    if lo_type and SMARTART_SUPPORTED_LINEAR_LIST_RE.search(lo_type):
        family = "linear_list"
    elif lo_type and SMARTART_SUPPORTED_LINEAR_PROCESS_RE.search(lo_type):
        family = "linear_process"
    else:
        family = short_id

    ch_max = _smartart_layout_ch_max(layout_root)
    has_lo = bool(shutil.which("libreoffice") or shutil.which("soffice"))
    has_atoms = _smartart_layout_has_computable_atoms(layout_root)

    if has_atoms and has_lo:
        return {
            "layout": lo_type,
            "family": family,
            "engine": "libreoffice_layout_def",
            "chMax": ch_max,
            "supportsNodeAddRemove": True,
            "reason": None,
        }

    # Fallback when layoutDef lacks full layout atoms (or LibreOffice is absent):
    # verified deterministic 1D geometric reflow for single-level linear lists/processes.
    if family in {"linear_list", "linear_process"}:
        if drawing_root is not None and any(drawing_root.iter(tag(DIAGRAM_DRAWING, "txXfrm"))):
            return {
                "layout": lo_type,
                "family": family,
                "engine": "unsupported",
                "chMax": ch_max,
                "supportsNodeAddRemove": False,
                "reason": "SmartArt shapes use detached dsp:txXfrm text-box coordinates and layoutDef cannot be recalculated via LibreOffice.",
            }
        return {
            "layout": lo_type,
            "family": family,
            "engine": "linear_reflow",
            "chMax": ch_max,
            "supportsNodeAddRemove": True,
            "reason": None,
        }

    return {
        "layout": lo_type,
        "family": family,
        "engine": "unsupported",
        "chMax": ch_max,
        "supportsNodeAddRemove": False,
        "reason": (
            f"SmartArt layout '{short_id}' requires LibreOffice layoutDef recalculation "
            f"(libreoffice={'available' if has_lo else 'missing'}, layoutAtoms={'present' if has_atoms else 'missing'})."
        ),
    }


def _resolve_smartart_parts(package, slide_part, slide_root, data_part, replacements, require_drawing=True):
    relationships = package_relationships(package, slide_part)
    data_ids = [rel_id for rel_id, (kind, part) in relationships.items()
                if kind.endswith("/diagramData") and part == data_part]
    rel_ids_el = None
    graphic_frame = None
    if len(data_ids) == 1:
        for gf in slide_root.iter(tag(PRESENTATION, "graphicFrame")):
            cand = next((el for el in gf.iter(tag(DIAGRAM, "relIds")) if el.get(tag(OFFICE_REL, "dm")) == data_ids[0]), None)
            if cand is not None:
                rel_ids_el = cand
                graphic_frame = gf
                break
    if len(data_ids) != 1 or rel_ids_el is None:
        raise ValueError("The slide does not reference this SmartArt data model")
    data = replacements.get(data_part)
    if data is None:
        data = parse_xml(package.read(data_part))

    layout_rel_id = rel_ids_el.get(tag(OFFICE_REL, "lo"))
    layout_part = None
    layout_root = None
    if layout_rel_id and layout_rel_id in relationships:
        l_kind, l_part = relationships[layout_rel_id]
        if l_kind.endswith("/diagramLayout") and l_part in package.namelist():
            layout_part = l_part
            layout_root = replacements.get(layout_part)
            if layout_root is None:
                layout_root = parse_xml(package.read(layout_part))

    drawing_ids = [element.get("relId") for element in data.iter(tag(DIAGRAM_DRAWING, "dataModelExt"))]
    drawing = None
    drawing_part = None
    if len(drawing_ids) == 1:
        drawing_type, cand_part = relationships.get(drawing_ids[0], ("", ""))
        if drawing_type.endswith("/diagramDrawing") and (cand_part in replacements or cand_part in package.namelist()):
            drawing_part = cand_part
            drawing = replacements.get(drawing_part)
            if drawing is None:
                drawing = parse_xml(package.read(drawing_part))
    if require_drawing and (drawing is None or drawing_part is None):
        raise UnsupportedByFormatError("SmartArt drawing cache is missing or ambiguous")
    return {
        "data": data,
        "drawing": drawing,
        "drawing_part": drawing_part,
        "drawing_rel_id": drawing_ids[0] if len(drawing_ids) == 1 else None,
        "layout": layout_root,
        "layout_part": layout_part,
        "graphic_frame": graphic_frame,
        "data_rel_id": data_ids[0],
        "relationships": relationships,
    }


def _smartart_sp_rect(sp):
    xfrm = sp.find(".//" + tag(DRAWING, "xfrm"))
    if xfrm is None:
        return None
    off = xfrm.find(tag(DRAWING, "off"))
    ext = xfrm.find(tag(DRAWING, "ext"))
    if off is None or ext is None:
        return None
    return (int(off.attrib["x"]), int(off.attrib["y"]), int(ext.attrib["cx"]), int(ext.attrib["cy"]))


def _set_smartart_sp_rect(sp, x, y, cx, cy):
    xfrm = sp.find(".//" + tag(DRAWING, "xfrm"))
    if xfrm is None:
        raise ValueError("SmartArt display shape has no transform")
    off = xfrm.find(tag(DRAWING, "off"))
    ext = xfrm.find(tag(DRAWING, "ext"))
    off.set("x", str(int(round(x))))
    off.set("y", str(int(round(y))))
    ext.set("cx", str(max(10000, int(round(cx)))))
    ext.set("cy", str(max(10000, int(round(cy)))))


def _set_smartart_shape_text(node, text):
    labels = list(node.iter(tag(DRAWING, "t")))
    if not labels:
        raise ValueError("SmartArt node has no editable text")
    labels[0].text = text
    for extra in labels[1:]:
        extra.text = ""


def edit_smartart_text(package, operation, slide_root, replacements):
    slide_part = operation["slidePart"]
    data_part = operation["dataPart"]
    model_id = operation["nodeId"]
    text = operation["text"]
    if not isinstance(text, str) or not text.strip() or len(text) > 2000 or "\r" in text or "\n" in text:
        raise ValueError("SmartArt requires a nonempty, single-line label")
    parts = _resolve_smartart_parts(package, slide_part, slide_root, data_part, replacements, require_drawing=True)
    data, drawing, drawing_part = parts["data"], parts["drawing"], parts["drawing_part"]
    points = list(data.iter(tag(DIAGRAM, "pt")))
    logical_points = [point for point in points if point.get("modelId") == model_id and point.get("type") in (None, "node")]
    if len(logical_points) != 1:
        raise ValueError("Expected a unique editable SmartArt node")
    label = list(logical_points[0].iter(tag(DRAWING, "t")))
    if not label:
        raise ValueError("SmartArt node has no editable label")
    orig_text = "".join(t.text or "" for t in label)
    display_ids = {point.get("modelId") for point in points if point.get("type") == "pres"
                   and any(child.get("presAssocID") == model_id for child in point.findall(tag(DIAGRAM, "prSet")))}
    matching_shapes = [shape for shape in drawing.iter(tag(DIAGRAM_DRAWING, "sp")) if shape.get("modelId") in display_ids]
    display_labels = [list(shape.iter(tag(DRAWING, "t"))) for shape in matching_shapes]
    display_labels = [labels for labels in display_labels if labels]
    if not display_labels or any("".join(t.text or "" for t in labels) != orig_text for labels in display_labels):
        raise ValueError("SmartArt data and drawing text cannot be synchronized safely")
    _set_smartart_shape_text(logical_points[0], text)
    for shape in matching_shapes:
        if list(shape.iter(tag(DRAWING, "t"))):
            _set_smartart_shape_text(shape, text)
    replacements[data_part] = data
    replacements[drawing_part] = drawing


def _smartart_convert_p_sp_to_dsp_sp(p_sp, model_id, shape_id, gf_x, gf_y):
    """Convert a PresentationML <p:sp> extracted from LibreOffice into an OOXML Diagram Drawing <dsp:sp>."""
    dsp_sp = XML.Element(
        tag(DIAGRAM_DRAWING, "sp"),
        nsmap={"dsp": DIAGRAM_DRAWING, "a": DRAWING},
        modelId=model_id,
    )

    def _remap_element(el, target_ns=None):
        qname = XML.QName(el)
        ns = target_ns if target_ns is not None else qname.namespace
        new_tag = f"{{{ns}}}{qname.localname}" if ns else qname.localname
        # Strip any external/dangling office relationship attributes (r:embed/r:link/r:id) from synthesized cache shapes
        clean_attrib = {
            k: v for k, v in el.attrib.items()
            if not k.startswith("{" + OFFICE_REL + "}")
        }
        node = XML.Element(new_tag, **clean_attrib)
        node.text = el.text
        node.tail = el.tail
        for child in el:
            if not isinstance(child.tag, str):
                continue
            child_q = XML.QName(child)
            # Replace blipFill referencing stripped r:embed with clean solidFill fallback
            if child_q.localname == "blipFill":
                fb = XML.SubElement(node, tag(DRAWING, "solidFill"))
                XML.SubElement(fb, tag(DRAWING, "srgbClr"), val="64748B")
                continue
            child_target_ns = DIAGRAM_DRAWING if child_q.namespace == PRESENTATION else None
            node.append(_remap_element(child, child_target_ns))
        return node

    nv = p_sp.find(tag(PRESENTATION, "nvSpPr"))
    dsp_nv = XML.SubElement(dsp_sp, tag(DIAGRAM_DRAWING, "nvSpPr"))
    c_nv_pr = nv.find(tag(PRESENTATION, "cNvPr")) if nv is not None else None
    XML.SubElement(
        dsp_nv,
        tag(DIAGRAM_DRAWING, "cNvPr"),
        id=str(shape_id),
        name=(c_nv_pr.get("name") if c_nv_pr is not None and c_nv_pr.get("name") else f"SmartArt Shape {shape_id}"),
    )
    c_nv_sp_pr = nv.find(tag(PRESENTATION, "cNvSpPr")) if nv is not None else None
    if c_nv_sp_pr is not None:
        dsp_nv.append(_remap_element(c_nv_sp_pr, DIAGRAM_DRAWING))
    else:
        XML.SubElement(dsp_nv, tag(DIAGRAM_DRAWING, "cNvSpPr"))

    sp_pr = p_sp.find(tag(PRESENTATION, "spPr"))
    if sp_pr is not None:
        dsp_sp_pr = _remap_element(sp_pr, DIAGRAM_DRAWING)
        xfrm = dsp_sp_pr.find(tag(DRAWING, "xfrm"))
        if xfrm is not None:
            off = xfrm.find(tag(DRAWING, "off"))
            if off is not None and "x" in off.attrib and "y" in off.attrib:
                off.set("x", str(int(off.attrib["x"]) - gf_x))
                off.set("y", str(int(off.attrib["y"]) - gf_y))
        dsp_sp.append(dsp_sp_pr)
    else:
        XML.SubElement(dsp_sp, tag(DIAGRAM_DRAWING, "spPr"))

    style = p_sp.find(tag(PRESENTATION, "style"))
    if style is not None:
        dsp_sp.append(_remap_element(style, DIAGRAM_DRAWING))

    tx_body = p_sp.find(tag(PRESENTATION, "txBody"))
    if tx_body is not None:
        dsp_sp.append(_remap_element(tx_body, DIAGRAM_DRAWING))

    return dsp_sp


def _smartart_collect_leaf_pres_dfs(data_root):
    """Collect presentation points in presParOf DFS order, distinguishing leaf vs container pres nodes."""
    pt_lst = data_root.find(tag(DIAGRAM, "ptLst"))
    cxn_lst = data_root.find(tag(DIAGRAM, "cxnLst"))
    if pt_lst is None or cxn_lst is None:
        return [], {}
    pt_by_id = {p.get("modelId"): p for p in pt_lst.findall(tag(DIAGRAM, "pt"))}
    children_map = {}
    has_parent = set()
    for c in cxn_lst.findall(tag(DIAGRAM, "cxn")):
        if c.get("type") == "presParOf":
            src, dst = c.get("srcId"), c.get("destId")
            if src and dst:
                children_map.setdefault(src, []).append((int(c.get("srcOrd", "0")), dst))
                has_parent.add(dst)
    for k in children_map:
        children_map[k].sort(key=lambda pair: pair[0])

    pres_pts = [p for p in pt_lst.findall(tag(DIAGRAM, "pt")) if p.get("type") == "pres"]
    roots = [p.get("modelId") for p in pres_pts if p.get("modelId") not in has_parent]
    ordered_leaves = []
    visited = set()

    def walk(pid):
        if pid in visited or pid not in pt_by_id:
            return
        visited.add(pid)
        kids = children_map.get(pid, [])
        if not kids:
            ordered_leaves.append(pt_by_id[pid])
        else:
            for _, cid in kids:
                walk(cid)

    for r in roots:
        walk(r)
    for p in pres_pts:
        pid = p.get("modelId")
        if pid not in visited and not children_map.get(pid):
            ordered_leaves.append(p)
    return ordered_leaves, pt_by_id


def _recalculate_smartart_drawing_via_libreoffice(package, slide_part, slide_root, graphic_frame, data_part, mutated_data, drawing_part, replacements):
    """Run LibreOffice's DrawingML Diagram layout engine (DIAGRAM_IGNORE_EXTDRAWINGS=1) to recompute SmartArt geometry from layoutDef."""
    soffice_bin = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice_bin:
        return None

    gf_xfrm = graphic_frame.find(tag(PRESENTATION, "xfrm"))
    if gf_xfrm is None:
        return None
    gf_off = gf_xfrm.find(tag(DRAWING, "off"))
    gf_ext = gf_xfrm.find(tag(DRAWING, "ext"))
    if gf_off is None or gf_ext is None:
        return None
    gf_x, gf_y = int(gf_off.attrib["x"]), int(gf_off.attrib["y"])
    gf_cx, gf_cy = int(gf_ext.attrib["cx"]), int(gf_ext.attrib["cy"])

    # Prepare temp slide containing ONLY the target graphicFrame so extracted shapes belong exclusively to this SmartArt
    temp_slide = deepcopy(slide_root)
    temp_tree = temp_slide.find(".//" + tag(PRESENTATION, "spTree"))
    target_dm_rel = next((el.get(tag(OFFICE_REL, "dm")) for el in graphic_frame.iter(tag(DIAGRAM, "relIds"))), None)
    for child in list(temp_tree):
        if not isinstance(child.tag, str):
            continue
        local = XML.QName(child).localname
        if local in {"nvGrpSpPr", "grpSpPr"}:
            continue
        if local == "graphicFrame" and any(el.get(tag(OFFICE_REL, "dm")) == target_dm_rel for el in child.iter(tag(DIAGRAM, "relIds"))):
            continue
        temp_tree.remove(child)

    # Strip dataModelExt ONLY in temp copy so LibreOffice ignores cached drawing and executes layoutDef
    temp_data = deepcopy(mutated_data)
    for ext_lst in list(temp_data.findall(tag(DIAGRAM, "extLst"))):
        for ext in list(ext_lst):
            if ext.find(tag(DIAGRAM_DRAWING, "dataModelExt")) is not None:
                ext_lst.remove(ext)
        if not len(ext_lst):
            temp_data.remove(ext_lst)

    slide_rels_part = str(PurePosixPath(slide_part).parent / "_rels" / (PurePosixPath(slide_part).name + ".rels"))
    drawing_rels_part = (
        str(PurePosixPath(drawing_part).parent / "_rels" / (PurePosixPath(drawing_part).name + ".rels"))
        if drawing_part else None
    )

    # Determine slide 0-based index in presentation.xml
    pres_main = replacements.get("ppt/presentation.xml")
    if pres_main is None:
        pres_main = parse_xml(package.read("ppt/presentation.xml"))
    slides_list = presentation_slides(package, pres_main)
    slide_index = next((idx for idx, s in enumerate(slides_list) if s["part"] == slide_part), 0)

    with tempfile.TemporaryDirectory(prefix="agy-smartart-lo-") as tmpdir:
        td = Path(tmpdir)
        temp_in = td / "input.pptx"
        with zipfile.ZipFile(temp_in, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in package.infolist():
                name = item.filename
                if drawing_part and name in {drawing_part, drawing_rels_part}:
                    continue
                if name == slide_part:
                    raw = XML.tostring(temp_slide, xml_declaration=True, encoding="UTF-8", standalone=True)
                elif name == data_part:
                    raw = XML.tostring(temp_data, xml_declaration=True, encoding="UTF-8", standalone=True)
                elif name == slide_rels_part and drawing_part:
                    rr = parse_xml(package.read(name))
                    for rel in list(rr):
                        if rel.get("Type", "").endswith("/diagramDrawing"):
                            target = resolve_relationship(str(PurePosixPath(slide_part).parent), rel.get("Target", ""))
                            if target == drawing_part:
                                rr.remove(rel)
                    raw = XML.tostring(rr, xml_declaration=True, encoding="UTF-8", standalone=True)
                elif name == "[Content_Types].xml" and drawing_part:
                    ct = parse_xml(package.read(name))
                    for ov in list(ct):
                        if ov.get("PartName") == "/" + drawing_part:
                            ct.remove(ov)
                    raw = XML.tostring(ct, xml_declaration=True, encoding="UTF-8", standalone=True)
                elif name in replacements:
                    val = replacements[name]
                    raw = val if isinstance(val, bytes) else XML.tostring(val, xml_declaration=True, encoding="UTF-8", standalone=True)
                else:
                    raw = package.read(name)
                zout.writestr(name, raw)

        env = dict(os.environ, HOME=tmpdir, DIAGRAM_IGNORE_EXTDRAWINGS="1")
        odp_dir = td / "odp"
        pptx_dir = td / "pptx"
        odp_dir.mkdir()
        pptx_dir.mkdir()
        p1 = subprocess.run(
            [soffice_bin, "--headless", "--nologo", "--nofirststartwizard",
             f"-env:UserInstallation=file://{td}/lo1", "--convert-to", "odp", "--outdir", str(odp_dir), str(temp_in)],
            env=env, capture_output=True, text=True, timeout=25,
        )
        odp_file = odp_dir / "input.odp"
        if p1.returncode != 0 or not odp_file.is_file():
            return None
        p2 = subprocess.run(
            [soffice_bin, "--headless", "--nologo", "--nofirststartwizard",
             f"-env:UserInstallation=file://{td}/lo2", "--convert-to", "pptx", "--outdir", str(pptx_dir), str(odp_file)],
            env=env, capture_output=True, text=True, timeout=25,
        )
        relaid_file = pptx_dir / "input.pptx"
        if p2.returncode != 0 or not relaid_file.is_file():
            return None

        with zipfile.ZipFile(relaid_file) as zre:
            re_pres = parse_xml(zre.read("ppt/presentation.xml"))
            re_slides = presentation_slides(zre, re_pres)
            if slide_index >= len(re_slides):
                return None
            re_slide_xml = parse_xml(zre.read(re_slides[slide_index]["part"]))
            re_tree = re_slide_xml.find(".//" + tag(PRESENTATION, "spTree"))
            if re_tree is None:
                return None
            # Collect all <p:sp> shapes (inside grpSp or directly in spTree)
            raw_sps = list(re_tree.findall(".//" + tag(PRESENTATION, "sp")))

    if not raw_sps:
        return None

    # Filter out the invisible full-frame background bounding box emitted for the diagram container
    filtered_sps = []
    for sp in raw_sps:
        sp_txt = text_content(sp, DRAWING).strip()
        xf = sp.find(".//" + tag(DRAWING, "xfrm"))
        off = xf.find(tag(DRAWING, "off")) if xf is not None else None
        ext = xf.find(tag(DRAWING, "ext")) if xf is not None else None
        if not sp_txt and off is not None and ext is not None:
            sx, sy = int(off.attrib["x"]), int(off.attrib["y"])
            scx, scy = int(ext.attrib["cx"]), int(ext.attrib["cy"])
            same_frame = (
                abs(sx - gf_x) <= 5000 and abs(sy - gf_y) <= 5000
                and abs(scx - gf_cx) <= 5000 and abs(scy - gf_cy) <= 5000
            )
            sp_pr = sp.find(tag(PRESENTATION, "spPr"))
            has_visible_fill = sp_pr is not None and any(
                sp_pr.find(tag(DRAWING, t)) is not None for t in ("solidFill", "gradFill", "blipFill", "pattFill")
            )
            if same_frame and not has_visible_fill:
                continue
        filtered_sps.append(sp)

    if not filtered_sps:
        return None

    # Map extracted <p:sp> shapes back to dataModel pres point modelIds for full re-editability
    leaf_pres, pt_by_id = _smartart_collect_leaf_pres_dfs(mutated_data)
    logical_pts = [p for p in pt_by_id.values() if p.get("type") in (None, "node")]
    logical_text_by_id = {p.get("modelId"): text_content(p, DRAWING).strip() for p in logical_pts}

    # Build expected leaf pres metadata: (pres_id, assoc_node_id, expected_text)
    pres_entries = []
    for p in leaf_pres:
        pr = p.find(tag(DIAGRAM, "prSet"))
        assoc = pr.get("presAssocID") if pr is not None else None
        pres_entries.append((p.get("modelId"), assoc, logical_text_by_id.get(assoc, "")))

    assigned_model_ids = [None] * len(filtered_sps)
    used_pres_indices = set()

    if len(filtered_sps) == len(pres_entries):
        # Exact 1:1 structural match in DFS layout order (handles both single-shape and 2-shape-per-node layouts like venn1)
        for i, (pid, _assoc, _txt) in enumerate(pres_entries):
            assigned_model_ids[i] = pid
            used_pres_indices.add(i)
    else:
        # Match text-bearing shapes to pres entries with matching logical node text first
        for sp_idx, sp in enumerate(filtered_sps):
            sp_txt = text_content(sp, DRAWING).strip()
            if not sp_txt:
                continue
            for p_idx, (pid, _assoc, exp_txt) in enumerate(pres_entries):
                if p_idx not in used_pres_indices and exp_txt == sp_txt:
                    assigned_model_ids[sp_idx] = pid
                    used_pres_indices.add(p_idx)
                    break
        # Assign remaining shapes to remaining leaf pres entries in order
        remaining_pres = [p_idx for p_idx in range(len(pres_entries)) if p_idx not in used_pres_indices]
        rem_cursor = 0
        for sp_idx in range(len(filtered_sps)):
            if assigned_model_ids[sp_idx] is None:
                if rem_cursor < len(remaining_pres):
                    assigned_model_ids[sp_idx] = pres_entries[remaining_pres[rem_cursor]][0]
                    rem_cursor += 1
                else:
                    assigned_model_ids[sp_idx] = "{" + str(uuid.uuid4()).upper() + "}"

    # Synthesize fresh OOXML <dsp:drawing>
    new_drawing = XML.Element(
        tag(DIAGRAM_DRAWING, "drawing"),
        nsmap={"dsp": DIAGRAM_DRAWING, "a": DRAWING},
    )
    sp_tree = XML.SubElement(new_drawing, tag(DIAGRAM_DRAWING, "spTree"))
    nv_grp = XML.SubElement(sp_tree, tag(DIAGRAM_DRAWING, "nvGrpSpPr"))
    XML.SubElement(nv_grp, tag(DIAGRAM_DRAWING, "cNvPr"), id="0", name="")
    XML.SubElement(nv_grp, tag(DIAGRAM_DRAWING, "cNvGrpSpPr"))
    XML.SubElement(sp_tree, tag(DIAGRAM_DRAWING, "grpSpPr"))

    next_id = 100
    for sp, mid in zip(filtered_sps, assigned_model_ids):
        dsp_sp = _smartart_convert_p_sp_to_dsp_sp(sp, mid, next_id, gf_x, gf_y)
        sp_tree.append(dsp_sp)
        next_id += 1

    # Verify EVERY non-empty logical node in mutated_data is represented with matching text in new_drawing
    pres_assoc_by_pres_id = {}
    for p in pt_by_id.values():
        if p.get("type") == "pres":
            pr = p.find(tag(DIAGRAM, "prSet"))
            if pr is not None and pr.get("presAssocID"):
                pres_assoc_by_pres_id[p.get("modelId")] = pr.get("presAssocID")

    rendered_texts_by_logical = {}
    for dsp_sp in sp_tree.findall(tag(DIAGRAM_DRAWING, "sp")):
        mid = dsp_sp.get("modelId")
        assoc = pres_assoc_by_pres_id.get(mid)
        txt = text_content(dsp_sp, DRAWING).strip()
        if assoc and txt:
            rendered_texts_by_logical.setdefault(assoc, []).append(txt)

    for nid, expected_txt in logical_text_by_id.items():
        if not expected_txt:
            continue
        rendered_list = rendered_texts_by_logical.get(nid, [])
        if expected_txt not in rendered_list:
            return None

    return new_drawing


def _smartart_mutate_data_model(data, layout_id, operation):
    """Mutate dgm:dataModel logical nodes, connections, and presentation tree (pres / presOf / presParOf)."""
    pt_lst = data.find(tag(DIAGRAM, "ptLst"))
    cxn_lst = data.find(tag(DIAGRAM, "cxnLst"))
    if pt_lst is None or cxn_lst is None:
        raise UnsupportedByFormatError("SmartArt data model is missing ptLst or cxnLst.")

    pts = list(pt_lst.findall(tag(DIAGRAM, "pt")))
    cxns = list(cxn_lst.findall(tag(DIAGRAM, "cxn")))
    doc_pts = [p for p in pts if p.get("type") == "doc"]
    if len(doc_pts) != 1:
        raise UnsupportedByFormatError("SmartArt diagram does not have a single document root.")
    doc_id = doc_pts[0].get("modelId")
    pt_by_id = {p.get("modelId"): p for p in pts}

    mode = operation["mode"]
    logical_pts = [p for p in pts if p.get("type") in (None, "node")]
    par_cxns = [c for c in cxns if c.get("type") in (None, "parOf")]
    pres_of_cxns = [c for c in cxns if c.get("type") == "presOf"]
    pres_par_cxns = [c for c in cxns if c.get("type") == "presParOf"]

    pres_id_attr = next((c.get("presId") for c in pres_of_cxns if c.get("presId")), None) or layout_id or ""

    def _pres_ids_for_logical(lid):
        return [c.get("destId") for c in pres_of_cxns if c.get("srcId") == lid and c.get("destId") in pt_by_id]

    def _renumber_sibling_pres(parent_logical_id):
        sib_cxns = [c for c in cxn_lst.findall(tag(DIAGRAM, "cxn")) if c.get("type") in (None, "parOf") and c.get("srcId") == parent_logical_id]
        sib_cxns.sort(key=lambda c: int(c.get("srcOrd", "0")))
        for idx, c in enumerate(sib_cxns):
            c.set("srcOrd", str(idx))
        sib_ids = [c.get("destId") for c in sib_cxns]
        cur_pts = {p.get("modelId"): p for p in pt_lst.findall(tag(DIAGRAM, "pt"))}
        cur_pres_of = [c for c in cxn_lst.findall(tag(DIAGRAM, "cxn")) if c.get("type") == "presOf"]

        # Group sibling pres points by positional slot (e.g. slot 0 = circN, slot 1 = circNTx)
        sib_pres_lists = []
        for sid in sib_ids:
            pids = [c.get("destId") for c in sorted(
                (c for c in cur_pres_of if c.get("srcId") == sid and c.get("destId") in cur_pts),
                key=lambda c: int(c.get("srcOrd", "0")),
            )]
            sib_pres_lists.append([cur_pts[pid] for pid in pids])

        if not sib_pres_lists or not sib_pres_lists[0]:
            return

        # Re-index presStyleIdx / presStyleCnt by presStyleLbl and renumber ordinal presName patterns (e.g. circ1..circN)
        max_slots = max(len(lst) for lst in sib_pres_lists)
        for slot in range(max_slots):
            slot_pts = [lst[slot] for lst in sib_pres_lists if slot < len(lst)]
            slot_prsets = [p.find(tag(DIAGRAM, "prSet")) for p in slot_pts]
            valid_prsets = [pr for pr in slot_prsets if pr is not None]
            if not valid_prsets:
                continue
            # Detect ordinal presName pattern like circ1..circN or circ1Tx..circNTx
            matches = [SMARTART_ORDINAL_PRES_NAME_RE.match(pr.get("presName", "")) for pr in valid_prsets]
            if all(m is not None for m in matches):
                prefixes = {(m.group(1), m.group(3)) for m in matches}
                if len(prefixes) == 1:
                    pfx, sfx = next(iter(prefixes))
                    for idx, pr in enumerate(valid_prsets, start=1):
                        pr.set("presName", f"{pfx}{idx}{sfx}")
            # Re-index presStyleIdx and presStyleCnt when siblings share a positive presStyleCnt
            style_lbls = {pr.get("presStyleLbl") for pr in valid_prsets if pr.get("presStyleLbl")}
            if len(style_lbls) == 1 and any(int(pr.get("presStyleCnt", "0")) > 0 for pr in valid_prsets if (pr.get("presStyleCnt") or "").isdigit()):
                for idx, pr in enumerate(valid_prsets):
                    pr.set("presStyleIdx", str(idx))
                    pr.set("presStyleCnt", str(len(valid_prsets)))

        # Re-index presParOf srcOrd per parent pres node in logical sibling order
        parent_pres_groups = {}
        for c in cxn_lst.findall(tag(DIAGRAM, "cxn")):
            if c.get("type") == "presParOf":
                parent_pres_groups.setdefault(c.get("srcId"), []).append(c)
        sib_pres_rank = {}
        rank = 0
        for lst in sib_pres_lists:
            for p in lst:
                sib_pres_rank[p.get("modelId")] = rank
                rank += 1
        for p_src, group_cxns in parent_pres_groups.items():
            if any(c.get("destId") in sib_pres_rank for c in group_cxns):
                group_cxns.sort(key=lambda c: (0, sib_pres_rank[c.get("destId")]) if c.get("destId") in sib_pres_rank else (1, int(c.get("srcOrd", "0"))))
                for idx, c in enumerate(group_cxns):
                    c.set("srcOrd", str(idx))

    if mode == "add":
        text = operation.get("text", "")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000 or "\r" in text or "\n" in text:
            raise ValueError("Adding a SmartArt node requires a nonempty, single-line text label")
        if len(logical_pts) >= 30:
            raise ValueError("SmartArt node count exceeds safe limit (30)")
        parent_id = operation.get("parentNodeId") or doc_id
        if parent_id != doc_id and (parent_id not in pt_by_id or pt_by_id[parent_id].get("type") not in (None, "node")):
            raise ValueError("Unknown SmartArt parentNodeId")

        sib_cxns = [c for c in par_cxns if c.get("srcId") == parent_id]
        sib_cxns.sort(key=lambda c: int(c.get("srcOrd", "0")))
        insert_idx = bounded_integer(operation.get("index", len(sib_cxns)), 0, len(sib_cxns))

        # Find a template sibling logical node under the same parent (or any non-doc node with pres points)
        tpl_id = sib_cxns[min(insert_idx, len(sib_cxns) - 1)].get("destId") if sib_cxns else None
        if tpl_id is None:
            # Adding first child to a hierarchy node: look for any existing non-root child node as template
            tpl_id = next((c.get("destId") for c in par_cxns if c.get("srcId") != doc_id and _pres_ids_for_logical(c.get("destId"))), None)
        if tpl_id is None or tpl_id not in pt_by_id:
            raise UnsupportedByFormatError("SmartArt diagram has no sibling template node to clone presentation structure.")

        new_node_id = "{" + str(uuid.uuid4()).upper() + "}"
        new_par_tid = "{" + str(uuid.uuid4()).upper() + "}"
        new_sib_tid = "{" + str(uuid.uuid4()).upper() + "}"

        new_node_pt = deepcopy(pt_by_id[tpl_id])
        new_node_pt.set("modelId", new_node_id)
        if not list(new_node_pt.iter(tag(DRAWING, "t"))):
            t_el = new_node_pt.find(tag(DIAGRAM, "t"))
            if t_el is None:
                t_el = XML.SubElement(new_node_pt, tag(DIAGRAM, "t"))
                XML.SubElement(t_el, tag(DRAWING, "bodyPr"))
                XML.SubElement(t_el, tag(DRAWING, "lstStyle"))
            p_el = t_el.find(tag(DRAWING, "p"))
            if p_el is None:
                p_el = XML.SubElement(t_el, tag(DRAWING, "p"))
            r_el = XML.SubElement(p_el, tag(DRAWING, "r"))
            XML.SubElement(r_el, tag(DRAWING, "t")).text = text
        else:
            _set_smartart_shape_text(new_node_pt, text)
        pt_lst.append(new_node_pt)
        pt_lst.append(XML.Element(tag(DIAGRAM, "pt"), modelId=new_par_tid, type="parTrans"))
        pt_lst.append(XML.Element(tag(DIAGRAM, "pt"), modelId=new_sib_tid, type="sibTrans"))

        # Shift existing sibling srcOrd >= insert_idx
        for c in sib_cxns:
            ord_val = int(c.get("srcOrd", "0"))
            if ord_val >= insert_idx:
                c.set("srcOrd", str(ord_val + 1))

        XML.SubElement(
            cxn_lst, tag(DIAGRAM, "cxn"),
            modelId="{" + str(uuid.uuid4()).upper() + "}",
            srcId=parent_id, destId=new_node_id,
            srcOrd=str(insert_idx), destOrd="0",
            parTransId=new_par_tid, sibTransId=new_sib_tid,
        )

        # Clone ALL pres points associated with tpl_id via presOf and attach to same parent pres node(s)
        tpl_pres_cxns = sorted(
            (c for c in pres_of_cxns if c.get("srcId") == tpl_id and c.get("destId") in pt_by_id),
            key=lambda c: int(c.get("srcOrd", "0")),
        )
        old_to_new_pres = {}
        for tpc in tpl_pres_cxns:
            old_pid = tpc.get("destId")
            new_pid = "{" + str(uuid.uuid4()).upper() + "}"
            old_to_new_pres[old_pid] = new_pid
            cloned_pres = deepcopy(pt_by_id[old_pid])
            cloned_pres.set("modelId", new_pid)
            for pr in cloned_pres.findall(tag(DIAGRAM, "prSet")):
                pr.set("presAssocID", new_node_id)
            pt_lst.append(cloned_pres)
            XML.SubElement(
                cxn_lst, tag(DIAGRAM, "cxn"),
                modelId="{" + str(uuid.uuid4()).upper() + "}",
                type="presOf", srcId=new_node_id, destId=new_pid,
                srcOrd=tpc.get("srcOrd", "0"), destOrd="0", presId=tpc.get("presId", pres_id_attr),
            )
        # Replicate presParOf relationships for cloned pres points
        for ppc in pres_par_cxns:
            old_dst = ppc.get("destId")
            if old_dst in old_to_new_pres:
                old_src = ppc.get("srcId")
                new_src = old_to_new_pres.get(old_src, old_src)
                XML.SubElement(
                    cxn_lst, tag(DIAGRAM, "cxn"),
                    modelId="{" + str(uuid.uuid4()).upper() + "}",
                    type="presParOf", srcId=new_src, destId=old_to_new_pres[old_dst],
                    srcOrd=str(int(ppc.get("srcOrd", "0")) + 1), destOrd="0",
                    presId=ppc.get("presId", pres_id_attr),
                )

        _renumber_sibling_pres(parent_id)
        return new_node_id

    # mode == "remove"
    target_id = operation.get("nodeId")
    if target_id is None:
        parent_id = operation.get("parentNodeId") or doc_id
        sib_cxns = sorted((c for c in par_cxns if c.get("srcId") == parent_id), key=lambda c: int(c.get("srcOrd", "0")))
        if not sib_cxns:
            raise ValueError("No SmartArt nodes found under parent")
        rm_idx = bounded_integer(operation.get("index", len(sib_cxns) - 1), 0, len(sib_cxns) - 1)
        target_id = sib_cxns[rm_idx].get("destId")

    if target_id not in pt_by_id or pt_by_id[target_id].get("type") not in (None, "node"):
        raise ValueError("Unknown SmartArt nodeId")

    # Collect target_id + any descendant logical nodes
    drop_logical = set()
    stack = [target_id]
    while stack:
        cur = stack.pop()
        if cur in drop_logical:
            continue
        drop_logical.add(cur)
        for c in par_cxns:
            if c.get("srcId") == cur and c.get("destId"):
                stack.append(c.get("destId"))

    remaining_logical = [p for p in logical_pts if p.get("modelId") not in drop_logical]
    if not remaining_logical:
        raise ValueError("SmartArt diagram must retain at least one node")

    parent_cxn = next((c for c in par_cxns if c.get("destId") == target_id), None)
    parent_id = parent_cxn.get("srcId") if parent_cxn is not None else doc_id

    # Collect transition & presentation points belonging to dropped logical nodes
    drop_ids = set(drop_logical)
    for c in par_cxns:
        if c.get("destId") in drop_logical:
            if c.get("parTransId"):
                drop_ids.add(c.get("parTransId"))
            if c.get("sibTransId"):
                drop_ids.add(c.get("sibTransId"))
    pres_stack = [c.get("destId") for c in pres_of_cxns if c.get("srcId") in drop_ids and c.get("destId")]
    while pres_stack:
        pid = pres_stack.pop()
        if pid in drop_ids:
            continue
        drop_ids.add(pid)
        for c in pres_par_cxns:
            if c.get("srcId") == pid and c.get("destId"):
                pres_stack.append(c.get("destId"))

    for p in list(pt_lst.findall(tag(DIAGRAM, "pt"))):
        if p.get("modelId") in drop_ids:
            pt_lst.remove(p)
    for c in list(cxn_lst.findall(tag(DIAGRAM, "cxn"))):
        if c.get("srcId") in drop_ids or c.get("destId") in drop_ids:
            cxn_lst.remove(c)

    _renumber_sibling_pres(parent_id)
    return target_id


def _edit_smartart_linear_fallback(data, drawing, classification, operation):
    """Deterministic 1D geometric reflow fallback for linear lists/processes without LibreOffice-computable layoutDef."""
    pt_lst = data.find(tag(DIAGRAM, "ptLst"))
    cxn_lst = data.find(tag(DIAGRAM, "cxnLst"))
    sp_tree = drawing.find(tag(DIAGRAM_DRAWING, "spTree"))
    if pt_lst is None or cxn_lst is None or sp_tree is None:
        raise UnsupportedByFormatError("SmartArt XML is missing ptLst, cxnLst, or spTree.")

    pts = list(pt_lst.findall(tag(DIAGRAM, "pt")))
    cxns = list(cxn_lst.findall(tag(DIAGRAM, "cxn")))
    doc_pts = [p for p in pts if p.get("type") == "doc"]
    if len(doc_pts) != 1:
        raise UnsupportedByFormatError("SmartArt diagram does not have a single document root.")
    doc_id = doc_pts[0].get("modelId")

    logical_pts = [p for p in pts if p.get("type") in (None, "node")]
    par_cxns = [c for c in cxns if c.get("type") in (None, "parOf")]
    child_par_cxns = [c for c in par_cxns if c.get("srcId") == doc_id]
    if len(child_par_cxns) != len(logical_pts) or len(logical_pts) < 1:
        raise UnsupportedByFormatError("SmartArt diagram has nested multi-level nodes and no computable layoutDef.")
    child_par_cxns.sort(key=lambda c: int(c.get("srcOrd", "0")))
    pt_by_id = {p.get("modelId"): p for p in pts}
    sp_by_model = {sp.get("modelId"): sp for sp in sp_tree.findall(tag(DIAGRAM_DRAWING, "sp"))}

    pres_by_assoc = {}
    for p in pts:
        if p.get("type") == "pres":
            pr = p.find(tag(DIAGRAM, "prSet"))
            if pr is not None and pr.get("presAssocID"):
                pres_by_assoc.setdefault(pr.get("presAssocID"), []).append(p)

    node_records = []
    for cxn in child_par_cxns:
        nid = cxn.get("destId")
        pres_list = [p for p in pres_by_assoc.get(nid, []) if p.get("modelId") in sp_by_model]
        if len(pres_list) != 1:
            raise UnsupportedByFormatError("SmartArt nodes must map 1:1 to display shapes for fallback linear reflow.")
        sp = sp_by_model[pres_list[0].get("modelId")]
        rect = _smartart_sp_rect(sp)
        if rect is None:
            raise UnsupportedByFormatError("SmartArt display shape is missing explicit coordinates.")
        sib_tid = cxn.get("sibTransId")
        sib_pres_list = [p for p in pres_by_assoc.get(sib_tid, []) if p.get("modelId") in sp_by_model] if sib_tid else []
        sib_sp = sp_by_model[sib_pres_list[0].get("modelId")] if len(sib_pres_list) == 1 else None
        node_records.append({
            "node_id": nid, "node_pt": pt_by_id[nid], "par_cxn": cxn,
            "par_trans_id": cxn.get("parTransId"), "sib_trans_id": sib_tid,
            "pres_pt": pres_list[0], "sp": sp, "rect": rect,
            "sib_pres_pt": sib_pres_list[0] if len(sib_pres_list) == 1 else None,
            "sib_sp": sib_sp, "sib_rect": _smartart_sp_rect(sib_sp) if sib_sp is not None else None,
        })

    rects = [rec["rect"] for rec in node_records]
    all_rects = list(rects) + [rec["sib_rect"] for rec in node_records if rec["sib_rect"] is not None]
    env_x0 = min(r[0] for r in all_rects)
    env_y0 = min(r[1] for r in all_rects)
    env_x1 = max(r[0] + r[2] for r in all_rects)
    env_y1 = max(r[1] + r[3] for r in all_rects)
    env_w = max(100000, env_x1 - env_x0)
    env_h = max(100000, env_y1 - env_y0)

    if len(rects) >= 2:
        dx_span = max(r[0] for r in rects) - min(r[0] for r in rects)
        dy_span = max(r[1] for r in rects) - min(r[1] for r in rects)
        axis = "horizontal" if dx_span >= dy_span else "vertical"
        coords = [r[0] if axis == "horizontal" else r[1] for r in rects]
        if any(coords[i] >= coords[i + 1] for i in range(len(coords) - 1)):
            raise UnsupportedByFormatError("SmartArt shapes are not monotonically ordered along a single axis.")
    else:
        axis = "horizontal" if "hList" in (classification["layout"] or "") or classification["family"] == "linear_process" else "vertical"

    pres_root_cxn = next((c for c in cxns if c.get("type") == "presOf" and c.get("srcId") == doc_id), None)
    pres_root_id = pres_root_cxn.get("destId") if pres_root_cxn is not None else None
    lo_type = classification["layout"] or ""
    has_arrows = any(rec["sib_sp"] is not None for rec in node_records)
    arrow_template_sp = next((rec["sib_sp"] for rec in node_records if rec["sib_sp"] is not None), None)
    arrow_template_pres = next((rec["sib_pres_pt"] for rec in node_records if rec["sib_pres_pt"] is not None), None)
    arrow_template_rect = next((rec["sib_rect"] for rec in node_records if rec["sib_rect"] is not None), None)

    mode = operation["mode"]
    if mode == "add":
        text = operation.get("text", "")
        if not isinstance(text, str) or not text.strip() or len(text) > 2000 or "\r" in text or "\n" in text:
            raise ValueError("Adding a SmartArt node requires a nonempty, single-line text label")
        if len(node_records) >= 20:
            raise ValueError("SmartArt node count exceeds safe linear reflow limit (20)")
        insert_idx = bounded_integer(operation.get("index", len(node_records)), 0, len(node_records))
        tpl = node_records[min(insert_idx, len(node_records) - 1)]

        new_node_id = "{" + str(uuid.uuid4()).upper() + "}"
        new_par_tid = "{" + str(uuid.uuid4()).upper() + "}"
        new_sib_tid = "{" + str(uuid.uuid4()).upper() + "}"
        new_pres_id = "{" + str(uuid.uuid4()).upper() + "}"

        new_node_pt = deepcopy(tpl["node_pt"])
        new_node_pt.set("modelId", new_node_id)
        _set_smartart_shape_text(new_node_pt, text)
        pt_lst.append(new_node_pt)
        pt_lst.append(XML.Element(tag(DIAGRAM, "pt"), modelId=new_par_tid, type="parTrans"))
        pt_lst.append(XML.Element(tag(DIAGRAM, "pt"), modelId=new_sib_tid, type="sibTrans"))

        new_pres_pt = deepcopy(tpl["pres_pt"])
        new_pres_pt.set("modelId", new_pres_id)
        for pr in new_pres_pt.findall(tag(DIAGRAM, "prSet")):
            pr.set("presAssocID", new_node_id)
        pt_lst.append(new_pres_pt)

        new_par_cxn = XML.SubElement(
            cxn_lst, tag(DIAGRAM, "cxn"),
            modelId="{" + str(uuid.uuid4()).upper() + "}",
            srcId=doc_id, destId=new_node_id, srcOrd=str(insert_idx), destOrd="0",
            parTransId=new_par_tid, sibTransId=new_sib_tid,
        )
        XML.SubElement(
            cxn_lst, tag(DIAGRAM, "cxn"),
            modelId="{" + str(uuid.uuid4()).upper() + "}",
            type="presOf", srcId=new_node_id, destId=new_pres_id, srcOrd="0", destOrd="0", presId=lo_type,
        )
        if pres_root_id:
            XML.SubElement(
                cxn_lst, tag(DIAGRAM, "cxn"),
                modelId="{" + str(uuid.uuid4()).upper() + "}",
                type="presParOf", srcId=pres_root_id, destId=new_pres_id, srcOrd="0", destOrd="0", presId=lo_type,
            )

        used_ids = {int(n.get("id", "0")) for n in sp_tree.iter(tag(DIAGRAM_DRAWING, "cNvPr")) if (n.get("id") or "").isdigit()}
        next_sp_id = max([10] + list(used_ids)) + 1
        new_sp = deepcopy(tpl["sp"])
        new_sp.set("modelId", new_pres_id)
        cnv = new_sp.find(".//" + tag(DIAGRAM_DRAWING, "cNvPr"))
        if cnv is not None:
            cnv.set("id", str(next_sp_id))
            cnv.set("name", f"Node {len(node_records) + 1}")
        _set_smartart_shape_text(new_sp, text)
        sp_tree.append(new_sp)

        node_records.insert(insert_idx, {
            "node_id": new_node_id, "node_pt": new_node_pt, "par_cxn": new_par_cxn,
            "par_trans_id": new_par_tid, "sib_trans_id": new_sib_tid,
            "pres_pt": new_pres_pt, "sp": new_sp, "rect": tpl["rect"],
            "sib_pres_pt": None, "sib_sp": None, "sib_rect": None,
        })
    else:
        if len(node_records) <= 1:
            raise ValueError("SmartArt diagram must retain at least one node")
        target_id = operation.get("nodeId")
        if target_id is not None:
            rm_idx = next((i for i, rec in enumerate(node_records) if rec["node_id"] == target_id), None)
            if rm_idx is None:
                raise ValueError("Unknown SmartArt nodeId")
        else:
            rm_idx = bounded_integer(operation.get("index", len(node_records) - 1), 0, len(node_records) - 1)
        removed_rec = node_records.pop(rm_idx)
        drop_ids = {removed_rec["node_id"], removed_rec["pres_pt"].get("modelId")}
        for extra_id in (removed_rec["par_trans_id"], removed_rec["sib_trans_id"]):
            if extra_id:
                drop_ids.add(extra_id)
        if removed_rec["sib_pres_pt"] is not None:
            drop_ids.add(removed_rec["sib_pres_pt"].get("modelId"))
        for p in list(pt_lst.findall(tag(DIAGRAM, "pt"))):
            if p.get("modelId") in drop_ids:
                pt_lst.remove(p)
        for c in list(cxn_lst.findall(tag(DIAGRAM, "cxn"))):
            if c.get("srcId") in drop_ids or c.get("destId") in drop_ids:
                cxn_lst.remove(c)
        if removed_rec["sp"] in list(sp_tree):
            sp_tree.remove(removed_rec["sp"])
        if removed_rec["sib_sp"] is not None and removed_rec["sib_sp"] in list(sp_tree):
            sp_tree.remove(removed_rec["sib_sp"])

    if has_arrows and arrow_template_sp is not None and arrow_template_pres is not None:
        used_ids = {int(n.get("id", "0")) for n in sp_tree.iter(tag(DIAGRAM_DRAWING, "cNvPr")) if (n.get("id") or "").isdigit()}
        next_sp_id = max([10] + list(used_ids)) + 1
        for i, rec in enumerate(node_records):
            need_arrow = i < len(node_records) - 1
            if need_arrow and rec["sib_sp"] is None:
                arr_pres_id = "{" + str(uuid.uuid4()).upper() + "}"
                arr_pres = deepcopy(arrow_template_pres)
                arr_pres.set("modelId", arr_pres_id)
                for pr in arr_pres.findall(tag(DIAGRAM, "prSet")):
                    pr.set("presAssocID", rec["sib_trans_id"] or rec["node_id"])
                pt_lst.append(arr_pres)
                XML.SubElement(
                    cxn_lst, tag(DIAGRAM, "cxn"),
                    modelId="{" + str(uuid.uuid4()).upper() + "}",
                    type="presOf", srcId=rec["sib_trans_id"] or rec["node_id"], destId=arr_pres_id,
                    srcOrd="0", destOrd="0", presId=lo_type,
                )
                if pres_root_id:
                    XML.SubElement(
                        cxn_lst, tag(DIAGRAM, "cxn"),
                        modelId="{" + str(uuid.uuid4()).upper() + "}",
                        type="presParOf", srcId=pres_root_id, destId=arr_pres_id,
                        srcOrd="0", destOrd="0", presId=lo_type,
                    )
                arr_sp = deepcopy(arrow_template_sp)
                arr_sp.set("modelId", arr_pres_id)
                cnv = arr_sp.find(".//" + tag(DIAGRAM_DRAWING, "cNvPr"))
                if cnv is not None:
                    cnv.set("id", str(next_sp_id))
                    next_sp_id += 1
                sp_tree.append(arr_sp)
                rec["sib_pres_pt"] = arr_pres
                rec["sib_sp"] = arr_sp
            elif not need_arrow and rec["sib_sp"] is not None:
                arr_pid = rec["sib_pres_pt"].get("modelId") if rec["sib_pres_pt"] is not None else None
                if rec["sib_sp"] in list(sp_tree):
                    sp_tree.remove(rec["sib_sp"])
                if arr_pid:
                    for p in list(pt_lst.findall(tag(DIAGRAM, "pt"))):
                        if p.get("modelId") == arr_pid:
                            pt_lst.remove(p)
                    for c in list(cxn_lst.findall(tag(DIAGRAM, "cxn"))):
                        if c.get("srcId") == arr_pid or c.get("destId") == arr_pid:
                            cxn_lst.remove(c)
                rec["sib_sp"] = None
                rec["sib_pres_pt"] = None

    for idx, rec in enumerate(node_records):
        rec["par_cxn"].set("srcOrd", str(idx))
    pres_order_ids = []
    for rec in node_records:
        pres_order_ids.append(rec["pres_pt"].get("modelId"))
        if rec["sib_pres_pt"] is not None:
            pres_order_ids.append(rec["sib_pres_pt"].get("modelId"))
    pres_ord_map = {pid: idx for idx, pid in enumerate(pres_order_ids)}
    for c in cxn_lst.findall(tag(DIAGRAM, "cxn")):
        if c.get("type") == "presParOf" and c.get("destId") in pres_ord_map:
            c.set("srcOrd", str(pres_ord_map[c.get("destId")]))

    n = len(node_records)
    arrow_count = sum(1 for rec in node_records if rec["sib_sp"] is not None)
    if axis == "horizontal":
        gap = max(60000, min(180000, int(env_w * 0.025))) if n > 1 else 0
        arrow_w = min(arrow_template_rect[2], max(120000, int(env_w * 0.06))) if (arrow_count and arrow_template_rect) else 0
        arrow_h = arrow_template_rect[3] if arrow_template_rect else int(env_h * 0.25)
        total_space = gap * max(0, n - 1) + arrow_w * arrow_count
        box_w = max(80000, (env_w - total_space) // n)
        box_h = env_h
        cursor = env_x0
        for rec in node_records:
            _set_smartart_sp_rect(rec["sp"], cursor, env_y0, box_w, box_h)
            cursor += box_w
            if rec["sib_sp"] is not None:
                _set_smartart_sp_rect(rec["sib_sp"], cursor + gap // 2, env_y0 + (box_h - arrow_h) // 2, arrow_w, arrow_h)
                cursor += arrow_w + gap
            else:
                cursor += gap
    else:
        gap = max(60000, min(180000, int(env_h * 0.03))) if n > 1 else 0
        arrow_h = min(arrow_template_rect[3], max(120000, int(env_h * 0.06))) if (arrow_count and arrow_template_rect) else 0
        arrow_w = arrow_template_rect[2] if arrow_template_rect else int(env_w * 0.25)
        total_space = gap * max(0, n - 1) + arrow_h * arrow_count
        box_h = max(80000, (env_h - total_space) // n)
        box_w = env_w
        cursor = env_y0
        for rec in node_records:
            _set_smartart_sp_rect(rec["sp"], env_x0, cursor, box_w, box_h)
            cursor += box_h
            if rec["sib_sp"] is not None:
                _set_smartart_sp_rect(rec["sib_sp"], env_x0 + (box_w - arrow_w) // 2, cursor + gap // 2, arrow_w, arrow_h)
                cursor += arrow_h + gap
            else:
                cursor += gap


def edit_smartart_add_or_remove_node(package, operation, slide_root, replacements, additions=None):
    """Add or remove a SmartArt node using LibreOffice DIAGRAM_IGNORE_EXTDRAWINGS layoutDef recalculation
    and drawing cache regeneration (with deterministic 1D reflow fallback for stub layoutDef linear diagrams).
    """
    slide_part = operation["slidePart"]
    data_part = operation["dataPart"]
    mode = operation.get("mode")
    if mode not in {"add", "remove"}:
        raise ValueError("SmartArt add_or_remove_node requires mode 'add' or 'remove'")
    parts = _resolve_smartart_parts(package, slide_part, slide_root, data_part, replacements, require_drawing=False)
    data = parts["data"]
    drawing = parts["drawing"]
    drawing_part = parts["drawing_part"]
    layout_root = parts["layout"]
    graphic_frame = parts["graphic_frame"]

    classification = classify_smartart_layout(data, drawing, layout_root)
    if not classification["supportsNodeAddRemove"]:
        raise UnsupportedByFormatError(classification["reason"])

    # Enforce layoutDef chMax upper bound for top-level children when adding a node
    if mode == "add" and classification["chMax"] is not None:
        doc_pt = next((p for p in data.iter(tag(DIAGRAM, "pt")) if p.get("type") == "doc"), None)
        doc_id = doc_pt.get("modelId") if doc_pt is not None else None
        parent_id = operation.get("parentNodeId") or doc_id
        if doc_id and parent_id == doc_id:
            cur_top = sum(
                1 for c in data.iter(tag(DIAGRAM, "cxn"))
                if c.get("type") in (None, "parOf") and c.get("srcId") == doc_id
            )
            if cur_top >= classification["chMax"]:
                raise UnsupportedByFormatError(
                    f"SmartArt layout '{classification['family']}' supports at most {classification['chMax']} top-level nodes (layoutDef chMax={classification['chMax']})."
                )

    if classification["engine"] == "libreoffice_layout_def":
        mutated_data = deepcopy(data)
        _smartart_mutate_data_model(mutated_data, classification["layout"], operation)
        new_drawing = _recalculate_smartart_drawing_via_libreoffice(
            package, slide_part, slide_root, graphic_frame, data_part, mutated_data, drawing_part, replacements
        )
        if new_drawing is not None:
            if drawing_part is None:
                if additions is None:
                    raise UnsupportedByFormatError("SmartArt diagram lacks a drawing part and cannot register one.")
                # Register a new ppt/diagrams/drawingN.xml part, relationship, content type, and dataModelExt
                existing_names = set(package.namelist()) | set(additions) | set(replacements)
                idx = 1
                while f"ppt/diagrams/drawing{idx}.xml" in existing_names:
                    idx += 1
                drawing_part = f"ppt/diagrams/drawing{idx}.xml"
                slide_rels_part = str(PurePosixPath(slide_part).parent / "_rels" / (PurePosixPath(slide_part).name + ".rels"))
                rels_root = load_edit_part(package, replacements, additions, slide_rels_part)
                used_rids = {r.get("Id") for r in rels_root}
                r_num = 1
                while f"rId{r_num}" in used_rids:
                    r_num += 1
                new_rid = f"rId{r_num}"
                XML.SubElement(
                    rels_root, tag(PACKAGE_REL, "Relationship"),
                    Id=new_rid,
                    Type="http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
                    Target=f"../diagrams/drawing{idx}.xml",
                )
                ct_root = load_edit_part(package, replacements, additions, "[Content_Types].xml")
                XML.SubElement(
                    ct_root, tag(CONTENT_TYPES, "Override"),
                    PartName="/" + drawing_part,
                    ContentType="application/vnd.ms-office.drawingml.diagramDrawing+xml",
                )
                ext_lst = mutated_data.find(tag(DIAGRAM, "extLst"))
                if ext_lst is None:
                    ext_lst = XML.SubElement(mutated_data, tag(DIAGRAM, "extLst"))
                ext = XML.SubElement(ext_lst, tag(DRAWING, "ext"), uri="http://schemas.microsoft.com/office/drawing/2008/diagram")
                XML.SubElement(ext, tag(DIAGRAM_DRAWING, "dataModelExt"), relId=new_rid, minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram")
                additions[drawing_part] = new_drawing
            else:
                replacements[drawing_part] = new_drawing
            replacements[data_part] = mutated_data
            return

        # LibreOffice could not recalculate all nodes for this layoutDef; allow fallback ONLY for linear list/process
        if classification["family"] not in {"linear_list", "linear_process"} or drawing is None or drawing_part is None:
            raise UnsupportedByFormatError(
                f"LibreOffice layoutDef recalculation could not lay out all nodes for SmartArt layout '{classification['family']}'."
            )

    if drawing is None or drawing_part is None:
        raise UnsupportedByFormatError("SmartArt drawing cache is missing for linear fallback reflow.")
    _edit_smartart_linear_fallback(data, drawing, classification, operation)
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
                      "shapes": pptx_shape_order(tree, include_table_rows=depth == 0)}]


PPTX_SHAPE_PRESETS = {
    "rectangle": "rect", "rect": "rect",
    "rounded_rectangle": "roundRect", "roundRect": "roundRect",
    "ellipse": "ellipse", "oval": "ellipse",
    "triangle": "triangle", "right_triangle": "rtTriangle",
    "diamond": "diamond", "pentagon": "pentagon", "hexagon": "hexagon", "octagon": "octagon",
    "parallelogram": "parallelogram", "trapezoid": "trapezoid",
    "right_arrow": "rightArrow", "left_arrow": "leftArrow", "up_arrow": "upArrow", "down_arrow": "downArrow",
    "chevron": "chevron", "home_plate": "homePlate",
    "star4": "star4", "star5": "star5", "cloud": "cloud", "heart": "heart",
    "callout": "wedgeRectCallout", "round_callout": "wedgeRoundRectCallout",
    "line": "line", "connector": "straightConnector1", "textbox": "rect",
}


def find_pptx_shape_with_parent(container, target_id):
    """Find a shape by cNvPr/@id recursively inside spTree and nested grpSp elements."""
    target = str(target_id)
    matches = []
    for child in container:
        if child.tag not in {tag(PRESENTATION, name) for name in ("sp", "pic", "cxnSp", "grpSp", "graphicFrame")}:
            continue
        nv = child.find("./*/" + tag(PRESENTATION, "cNvPr"))
        if nv is not None and nv.get("id") == target:
            matches.append((container, child))
        if child.tag == tag(PRESENTATION, "grpSp"):
            matches.extend(find_pptx_shape_with_parent(child, target))
    return matches


def _apply_pptx_run_props(run, spec):
    props = xml_child(run, DRAWING, "rPr", ("t",))
    if "fontSizePt" in spec:
        props.set("sz", str(bounded_integer(round(float(spec["fontSizePt"]) * 100), 100, 40000)))
    for key, attr in (("bold", "b"), ("italic", "i")):
        if key in spec:
            props.set(attr, "1" if spec[key] is True else "0")
    if "underline" in spec:
        props.set("u", "sng" if spec["underline"] is True else ("none" if spec["underline"] is False else str(spec["underline"])))
    if "strikethrough" in spec or "strike" in spec:
        st_val = spec.get("strikethrough", spec.get("strike"))
        props.set("strike", "sngStrike" if st_val else "noStrike")
    fc = spec.get("fontColor", spec.get("textColor", spec.get("color")))
    if fc is not None:
        cleaned = str(fc).lstrip("#")
        if not re.fullmatch(r"[0-9A-Fa-f]{6}", cleaned):
            raise ValueError("Use a six-digit RGB color")
        for old_fill in list(props):
            if isinstance(old_fill.tag, str) and XML.QName(old_fill).localname in {"noFill", "solidFill", "gradFill"}:
                props.remove(old_fill)
        sf = xml_child(props, DRAWING, "solidFill", ("effectLst", "highlight", "uLnTx", "uLn", "uFillTx", "uFill", "latin", "ea", "cs", "sym", "hlinkClick", "extLst"))
        XML.SubElement(sf, tag(DRAWING, "srgbClr"), val=cleaned.upper())
    if "fontFamily" in spec and spec["fontFamily"]:
        face = str(spec["fontFamily"])[:128]
        xml_child(props, DRAWING, "latin", ("ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "extLst")).set("typeface", face)
        xml_child(props, DRAWING, "ea", ("cs", "sym", "hlinkClick", "hlinkMouseOver", "extLst")).set("typeface", face)
        xml_child(props, DRAWING, "cs", ("sym", "hlinkClick", "hlinkMouseOver", "extLst")).set("typeface", face)


def _apply_pptx_paragraph_props(para, spec):
    ppr = xml_child(para, DRAWING, "pPr", ("r", "br", "fld", "endParaRPr"))
    if "alignment" in spec:
        al_map = {"left": "l", "center": "ctr", "right": "r", "justify": "just"}
        al = str(spec["alignment"])
        if al not in al_map:
            raise ValueError(f"Unsupported PPTX alignment: {al}")
        ppr.set("algn", al_map[al])
    if "level" in spec:
        ppr.set("lvl", str(bounded_integer(spec["level"], 0, 8)))
    if "lineSpacingPercent" in spec:
        ls = xml_child(ppr, DRAWING, "lnSpc", ("spcBef", "spcAft", "buClrTx", "buClr", "buSzTx", "buSzPct", "buSzPts", "buFontTx", "buFont", "buNone", "buAutoNum", "buChar", "tabLst", "defRPr", "extLst"))
        ls.clear()
        XML.SubElement(ls, tag(DRAWING, "spcPct"), val=str(bounded_integer(round(float(spec["lineSpacingPercent"]) * 1000), 50000, 500000)))
    if "spaceBeforePt" in spec:
        sb = xml_child(ppr, DRAWING, "spcBef", ("spcAft", "buClrTx", "buClr", "buSzTx", "buSzPct", "buSzPts", "buFontTx", "buFont", "buNone", "buAutoNum", "buChar", "tabLst", "defRPr", "extLst"))
        sb.clear()
        XML.SubElement(sb, tag(DRAWING, "spcPts"), val=str(bounded_integer(round(float(spec["spaceBeforePt"]) * 100), 0, 158400)))
    if "spaceAfterPt" in spec:
        sa = xml_child(ppr, DRAWING, "spcAft", ("buClrTx", "buClr", "buSzTx", "buSzPct", "buSzPts", "buFontTx", "buFont", "buNone", "buAutoNum", "buChar", "tabLst", "defRPr", "extLst"))
        sa.clear()
        XML.SubElement(sa, tag(DRAWING, "spcPts"), val=str(bounded_integer(round(float(spec["spaceAfterPt"]) * 100), 0, 158400)))
    if "bullet" in spec:
        for old_bu in list(ppr):
            if isinstance(old_bu.tag, str) and XML.QName(old_bu).localname in {"buNone", "buChar", "buAutoNum"}:
                ppr.remove(old_bu)
        bu = spec["bullet"]
        if bu is False or bu == "none":
            xml_child(ppr, DRAWING, "buNone", ("tabLst", "defRPr", "extLst"))
        elif bu == "number" or bu == "decimal":
            xml_child(ppr, DRAWING, "buAutoNum", ("tabLst", "defRPr", "extLst")).set("type", "arabicPeriod")
        else:
            ch = "•" if bu is True else str(bu)[:4]
            xml_child(ppr, DRAWING, "buChar", ("tabLst", "defRPr", "extLst")).set("char", ch)


def _set_pptx_txbody_content(tx_body, operation):
    """Update a PPTX txBody with plain multi-line text, targeted paragraph/run edit, or structured paragraphs."""
    paras = tx_body.findall(tag(DRAWING, "p"))
    if isinstance(operation.get("paragraphs"), list) and operation["paragraphs"]:
        for old_p in paras:
            tx_body.remove(old_p)
        for p_spec in operation["paragraphs"][:200]:
            p_el = XML.SubElement(tx_body, tag(DRAWING, "p"))
            if isinstance(p_spec, dict):
                _apply_pptx_paragraph_props(p_el, p_spec)
                runs_spec = p_spec.get("runs")
                if isinstance(runs_spec, list) and runs_spec:
                    for r_spec in runs_spec[:200]:
                        r_el = XML.SubElement(p_el, tag(DRAWING, "r"))
                        _apply_pptx_run_props(r_el, r_spec)
                        XML.SubElement(r_el, tag(DRAWING, "t")).text = str(r_spec.get("text", ""))[:20_000]
                else:
                    r_el = XML.SubElement(p_el, tag(DRAWING, "r"))
                    _apply_pptx_run_props(r_el, p_spec)
                    XML.SubElement(r_el, tag(DRAWING, "t")).text = str(p_spec.get("text", ""))[:20_000]
            else:
                r_el = XML.SubElement(p_el, tag(DRAWING, "r"))
                XML.SubElement(r_el, tag(DRAWING, "t")).text = str(p_spec)[:20_000]
        return

    if "paragraphIndex" in operation:
        if not paras:
            raise ValueError("Text body contains no paragraphs")
        p_el = paras[bounded_integer(operation["paragraphIndex"], 0, len(paras) - 1)]
        runs = p_el.findall(tag(DRAWING, "r"))
        if "runIndex" in operation:
            if not runs:
                raise ValueError("Paragraph contains no runs")
            r_el = runs[bounded_integer(operation["runIndex"], 0, len(runs) - 1)]
            t_el = r_el.find(tag(DRAWING, "t"))
            if t_el is None:
                t_el = XML.SubElement(r_el, tag(DRAWING, "t"))
            t_el.text = str(operation["text"])[:20_000]
        else:
            first_rpr = deepcopy(runs[0].find(tag(DRAWING, "rPr"))) if runs and runs[0].find(tag(DRAWING, "rPr")) is not None else None
            for old_r in runs:
                p_el.remove(old_r)
            new_r = XML.SubElement(p_el, tag(DRAWING, "r"))
            if first_rpr is not None:
                new_r.append(first_rpr)
            XML.SubElement(new_r, tag(DRAWING, "t")).text = str(operation["text"])[:20_000]
        return

    first_ppr = deepcopy(paras[0].find(tag(DRAWING, "pPr"))) if paras and paras[0].find(tag(DRAWING, "pPr")) is not None else None
    first_run = paras[0].find(tag(DRAWING, "r")) if paras else None
    first_rpr = deepcopy(first_run.find(tag(DRAWING, "rPr"))) if first_run is not None and first_run.find(tag(DRAWING, "rPr")) is not None else None
    for old_p in paras:
        tx_body.remove(old_p)
    lines = str(operation["text"])[:20_000].split("\n")
    for line_text in lines:
        p_el = XML.SubElement(tx_body, tag(DRAWING, "p"))
        if first_ppr is not None:
            p_el.append(deepcopy(first_ppr))
        r_el = XML.SubElement(p_el, tag(DRAWING, "r"))
        if first_rpr is not None:
            r_el.append(deepcopy(first_rpr))
        XML.SubElement(r_el, tag(DRAWING, "t")).text = line_text


def pptx_append_shape(package, slide, tree, replacements, additions, operation):
    from pptx import Presentation as SlideDocument
    from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
    from pptx.util import Pt

    bounds = operation["boundsPt"]
    if not isinstance(bounds, list) or len(bounds) != 4:
        raise ValueError("Expected x, y, width, height in points")
    x, y, width, height = [Pt(float(v)) for v in bounds]
    if not all(-14400 <= float(v) <= 14400 for v in bounds[:2]) or not all(1 <= float(v) <= 14400 for v in bounds[2:]):
        raise ValueError("Shape bounds out of range")
    temporary = SlideDocument()
    shapes = temporary.slides.add_slide(temporary.slide_layouts[6]).shapes
    op = operation["op"]
    if op == "pptx.add_shape":
        raw_kind = str(operation.get("kind", "rectangle"))
        if raw_kind == "textbox":
            shape = shapes.add_textbox(x, y, width, height)
            shape.text = str(operation.get("text", ""))[:20_000]
        elif raw_kind in {"line", "connector"}:
            shape = shapes.add_shape(MSO_AUTO_SHAPE_TYPE.RECTANGLE, x, y, width, height)
            prst = shape.element.find(".//" + tag(DRAWING, "prstGeom"))
            if prst is not None:
                prst.set("prst", PPTX_SHAPE_PRESETS[raw_kind])
        else:
            prst_name = PPTX_SHAPE_PRESETS.get(raw_kind)
            if not prst_name and re.fullmatch(r"[A-Za-z][A-Za-z0-9]{1,40}", raw_kind):
                prst_name = raw_kind
            if not prst_name:
                raise ValueError(f"Unsupported PPTX shape kind: {raw_kind}")
            shape = shapes.add_shape(MSO_AUTO_SHAPE_TYPE.RECTANGLE, x, y, width, height)
            prst = shape.element.find(".//" + tag(DRAWING, "prstGeom"))
            if prst is not None:
                prst.set("prst", prst_name)
            shape.text = str(operation.get("text", ""))[:20_000]
    elif op == "pptx.add_image":
        image, fmt = safe_image(operation["imageBase64"])
        shape = shapes.add_picture(io.BytesIO(image), x, y, width, height)
    else:
        rows = operation["rows"]
        count = len(rows[0]) if rows else 0
        if not 1 <= len(rows) <= 100 or not 1 <= count <= 30 or any(len(row) != count for row in rows):
            raise ValueError("Expected a bounded rectangular table")
        shape = shapes.add_table(len(rows), count, x, y, width, height)
        for i, row in enumerate(rows):
            for j, text in enumerate(row):
                shape.table.cell(i, j).text = str(text)[:20_000]
    element = deepcopy(shape.element)
    used = {node.get("id") for node in tree.iter(tag(PRESENTATION, "cNvPr"))}
    properties = next(element.iter(tag(PRESENTATION, "cNvPr")))
    properties.set("id", next(str(i) for i in range(1, len(used) + 2) if str(i) not in used))
    if op in {"pptx.add_shape", "pptx.add_image"} and isinstance(operation.get("style"), dict):
        pptx_style(element, operation["style"])
    if op == "pptx.add_image":
        target = allocate_part(package, additions, "ppt/media/artifact-image", "." + fmt)
        rid = add_package_part(package, replacements, additions, slide, target, "image", f"image/{fmt}", image)
        next(element.iter(tag(DRAWING, "blip"))).set(tag(OFFICE_REL, "embed"), rid)
    extension = tree.find(tag(PRESENTATION, "extLst"))
    tree.insert(tree.index(extension) if extension is not None else len(tree), element)
    return properties.get("id")


def pptx_edit_slide_list(package, replacements, additions, operation):
    source = MAIN_PART["pptx"]
    root = load_edit_part(package, replacements, additions, source)
    slides = xml_child(root, PRESENTATION, "sldIdLst", ("sldSz", "notesSz", "defaultTextStyle", "extLst"))
    if operation["op"] == "pptx.add_slide":
        layout = operation["layoutPart"]
        if not re.fullmatch(r"ppt/slideLayouts/slideLayout[0-9]+\.xml", layout) or layout not in package.namelist():
            raise ValueError("Unknown slide layout")
        target = allocate_part(package, additions, "ppt/slides/slide", ".xml")
        root = XML.Element(tag(PRESENTATION, "sld"), nsmap={"p": PRESENTATION, "a": DRAWING, "r": OFFICE_REL})
        tree = XML.SubElement(XML.SubElement(root, tag(PRESENTATION, "cSld")), tag(PRESENTATION, "spTree"))
        nonvisual = XML.SubElement(tree, tag(PRESENTATION, "nvGrpSpPr"))
        XML.SubElement(nonvisual, tag(PRESENTATION, "cNvPr"), id="1", name="")
        XML.SubElement(nonvisual, tag(PRESENTATION, "cNvGrpSpPr"))
        XML.SubElement(nonvisual, tag(PRESENTATION, "nvPr"))
        XML.SubElement(tree, tag(PRESENTATION, "grpSpPr"))
        rid = add_package_part(package, replacements, additions, source, target, "slide",
                               "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
                               XML.tostring(root))
        rels = XML.Element(tag(RELATIONSHIPS, "Relationships"))
        XML.SubElement(rels, tag(RELATIONSHIPS, "Relationship"), Id="rId1", Type=OFFICE_REL + "/slideLayout",
                       Target=posixpath.relpath(layout, "ppt/slides"))
        additions[f"ppt/slides/_rels/{PurePosixPath(target).name}.rels"] = XML.tostring(rels)
        slide_id = max([255] + [int(slide.attrib["id"]) for slide in slides]) + 1
        slide = XML.Element(tag(PRESENTATION, "sldId"), id=str(slide_id))
        slide.set(tag(OFFICE_REL, "id"), rid)
        slides.insert(bounded_integer(operation.get("index", len(slides)), 0, len(slides)), slide)
        return target
    else:
        current = bounded_integer(operation["index"], 0, len(slides) - 1)
        slide = slides[current]
        if operation["op"] == "pptx.remove_slide":
            if len(slides) == 1:
                raise ValueError("A presentation must retain at least one slide")
            slides.remove(slide)
        else:
            index = bounded_integer(operation["toIndex"], 0, len(slides) - 1)
            slides.remove(slide)
            slides.insert(index, slide)


def pptx_group(tree, operation):
    """Group any >= 2 distinct sibling shapes (contiguous or non-contiguous) while preserving relative stacking order."""
    identifiers = {str(identifier) for identifier in operation["shapeIds"]}
    shapes = []
    for shape in tree:
        node = shape.find("./*/" + tag(PRESENTATION, "cNvPr"))
        if node is not None and node.get("id") in identifiers:
            if shape.tag not in {tag(PRESENTATION, name) for name in ("sp", "pic", "cxnSp", "grpSp")}:
                raise ValueError("The selected shape cannot be grouped")
            shapes.append(shape)
    if len(shapes) != len(identifiers) or len(shapes) < 2:
        raise ValueError("Select at least two distinct top-level shapes")
    insert_offset = tree.index(shapes[0])
    used = {node.get("id") for node in tree.iter(tag(PRESENTATION, "cNvPr"))}
    group = XML.Element(tag(PRESENTATION, "grpSp"))
    nv = XML.SubElement(group, tag(PRESENTATION, "nvGrpSpPr"))
    XML.SubElement(nv, tag(PRESENTATION, "cNvPr"), id=next(str(i) for i in range(1, len(used) + 2) if str(i) not in used), name="Group")
    XML.SubElement(nv, tag(PRESENTATION, "cNvGrpSpPr"))
    XML.SubElement(nv, tag(PRESENTATION, "nvPr"))
    rectangles = []
    for shape in shapes:
        coordinates = shape_transform(shape)
        if not coordinates or not coordinates.get("geomBoundsPt"):
            raise ValueError("Every grouped shape needs explicit geometry")
        rectangles.append(coordinates["geomBoundsPt"])
    transform = XML.SubElement(XML.SubElement(group, tag(PRESENTATION, "grpSpPr")), tag(DRAWING, "xfrm"))
    x = min(box["x"] for box in rectangles)
    y = min(box["y"] for box in rectangles)
    width = max(box["x"] + box["width"] for box in rectangles) - x
    height = max(box["y"] + box["height"] for box in rectangles) - y
    for name in ("off", "chOff"):
        XML.SubElement(transform, tag(DRAWING, name), x=str(round(x * 12700)), y=str(round(y * 12700)))
    for name in ("ext", "chExt"):
        XML.SubElement(transform, tag(DRAWING, name), cx=str(max(1, round(width * 12700))),
                       cy=str(max(1, round(height * 12700))))
    tree.insert(insert_offset, group)
    for shape in shapes:
        group.append(shape)


def _pptx_ungroup_transform_child(child, g_off, g_ext, g_ch_off, g_ch_ext, g_rot_deg, g_flip_h, g_flip_v):
    """Apply parent group's affine xfrm (scale/translate/flip/rotate) onto a child's xfrm when ungrouping."""
    child_xfrm = next((node for node in (
        child.find("./" + tag(PRESENTATION, "spPr") + "/" + tag(DRAWING, "xfrm")),
        child.find("./" + tag(PRESENTATION, "grpSpPr") + "/" + tag(DRAWING, "xfrm")),
        child.find(tag(PRESENTATION, "xfrm")),
    ) if node is not None), None)
    if child_xfrm is None:
        return
    c_off = child_xfrm.find(tag(DRAWING, "off"))
    c_ext = child_xfrm.find(tag(DRAWING, "ext"))
    if c_off is None or c_ext is None:
        return
    cx_emu = int(c_off.attrib["x"])
    cy_emu = int(c_off.attrib["y"])
    cw_emu = int(c_ext.attrib["cx"])
    ch_emu = int(c_ext.attrib["cy"])

    sx = (g_ext[0] / float(g_ch_ext[0])) if g_ch_ext[0] else 1.0
    sy = (g_ext[1] / float(g_ch_ext[1])) if g_ch_ext[1] else 1.0
    nx = g_off[0] + (cx_emu - g_ch_off[0]) * sx
    ny = g_off[1] + (cy_emu - g_ch_off[1]) * sy
    nw = max(1.0, cw_emu * sx)
    nh = max(1.0, ch_emu * sy)

    # Apply group flips relative to group bounding box
    if g_flip_h:
        nx = g_off[0] + g_ext[0] - (nx - g_off[0]) - nw
        child_xfrm.set("flipH", "0" if child_xfrm.get("flipH") in ("1", "true") else "1")
    if g_flip_v:
        ny = g_off[1] + g_ext[1] - (ny - g_off[1]) - nh
        child_xfrm.set("flipV", "0" if child_xfrm.get("flipV") in ("1", "true") else "1")

    # Apply group rotation around group center onto child center + rotation angle
    if g_rot_deg:
        gcx = g_off[0] + g_ext[0] / 2.0
        gcy = g_off[1] + g_ext[1] / 2.0
        ccx = nx + nw / 2.0
        ccy = ny + nh / 2.0
        rad = math.radians(g_rot_deg)
        dx, dy = ccx - gcx, ccy - gcy
        rcx = gcx + dx * math.cos(rad) - dy * math.sin(rad)
        rcy = gcy + dx * math.sin(rad) + dy * math.cos(rad)
        nx = rcx - nw / 2.0
        ny = rcy - nh / 2.0
        prev_rot = int(child_xfrm.get("rot", "0")) / 60000.0
        new_rot = (prev_rot + g_rot_deg) % 360.0
        child_xfrm.set("rot", str(int(round(new_rot * 60000))))

    c_off.set("x", str(int(round(nx))))
    c_off.set("y", str(int(round(ny))))
    c_ext.set("cx", str(max(1, int(round(nw)))))
    c_ext.set("cy", str(max(1, int(round(nh)))))


def pptx_style(shape, operation):
    if shape.tag not in {tag(PRESENTATION, "sp"), tag(PRESENTATION, "pic"), tag(PRESENTATION, "cxnSp")}:
        raise ValueError("Style editing requires a shape, picture, or connector")
    properties = shape.find(tag(PRESENTATION, "spPr"))
    if properties is None:
        raise ValueError("Shape has no spPr element")

    if "fill" in operation:
        fill_val = operation["fill"]
        fills = {"noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"}
        for child in list(properties):
            if isinstance(child.tag, str) and XML.QName(child).localname in fills:
                properties.remove(child)
        before_fill = ("ln", "effectLst", "effectDag", "scene3d", "sp3d", "extLst")
        if fill_val is None or fill_val == "none" or (isinstance(fill_val, dict) and fill_val.get("type") == "none"):
            xml_child(properties, DRAWING, "noFill", before_fill)
        elif isinstance(fill_val, dict) and fill_val.get("type") == "gradient":
            stops = fill_val.get("stops") or []
            if len(stops) < 2:
                raise ValueError("Gradient fill requires at least 2 color stops")
            grad = xml_child(properties, DRAWING, "gradFill", before_fill)
            gs_lst = XML.SubElement(grad, tag(DRAWING, "gsLst"))
            for st in stops[:10]:
                pos = bounded_integer(round(float(st["posPercent"]) * 1000), 0, 100000)
                gs = XML.SubElement(gs_lst, tag(DRAWING, "gs"), pos=str(pos))
                c_hex = str(st["color"]).lstrip("#")
                if not re.fullmatch(r"[0-9A-Fa-f]{6}", c_hex):
                    raise ValueError("Use a six-digit RGB color")
                srgb = XML.SubElement(gs, tag(DRAWING, "srgbClr"), val=c_hex.upper())
                if "opacityPercent" in st:
                    XML.SubElement(srgb, tag(DRAWING, "alpha"), val=str(bounded_integer(st["opacityPercent"], 0, 100) * 1000))
            angle = bounded_integer(round(float(fill_val.get("angleDegrees", 90))) % 360, 0, 359)
            XML.SubElement(grad, tag(DRAWING, "lin"), ang=str(angle * 60000), scaled="1")
        else:
            color_str = fill_val["color"] if isinstance(fill_val, dict) else str(fill_val)
            color = color_str.lstrip("#")
            if not re.fullmatch(r"[0-9A-Fa-f]{6}", color):
                raise ValueError("Use a six-digit RGB color")
            fill = xml_child(properties, DRAWING, "solidFill", before_fill)
            rgb = XML.SubElement(fill, tag(DRAWING, "srgbClr"), val=color.upper())
            op_pct = fill_val.get("opacityPercent", operation.get("opacityPercent")) if isinstance(fill_val, dict) else operation.get("opacityPercent")
            if op_pct is not None:
                XML.SubElement(rgb, tag(DRAWING, "alpha"), val=str(bounded_integer(op_pct, 0, 100) * 1000))
    elif "opacityPercent" in operation:
        sf = properties.find(tag(DRAWING, "solidFill"))
        if sf is not None:
            clr = sf.find(tag(DRAWING, "srgbClr")) or sf.find(tag(DRAWING, "schemeClr"))
            if clr is not None:
                old_a = clr.find(tag(DRAWING, "alpha"))
                if old_a is not None:
                    clr.remove(old_a)
                XML.SubElement(clr, tag(DRAWING, "alpha"), val=str(bounded_integer(operation["opacityPercent"], 0, 100) * 1000))

    outline = operation.get("outline", operation.get("border"))
    if outline is not None:
        ln = xml_child(properties, DRAWING, "ln", ("effectLst", "effectDag", "scene3d", "sp3d", "extLst"))
        ln.clear()
        if outline is False or outline == "none" or (isinstance(outline, dict) and outline.get("none")):
            XML.SubElement(ln, tag(DRAWING, "noFill"))
        else:
            cfg = outline if isinstance(outline, dict) else {"color": str(outline)}
            if "widthPt" in cfg:
                ln.set("w", str(bounded_integer(round(float(cfg["widthPt"]) * 12700), 1270, 1270000)))
            color = str(cfg.get("color", "000000")).lstrip("#")
            if not re.fullmatch(r"[0-9A-Fa-f]{6}", color):
                raise ValueError("Use a six-digit RGB color")
            sf = XML.SubElement(ln, tag(DRAWING, "solidFill"))
            srgb = XML.SubElement(sf, tag(DRAWING, "srgbClr"), val=color.upper())
            if "opacityPercent" in cfg:
                XML.SubElement(srgb, tag(DRAWING, "alpha"), val=str(bounded_integer(cfg["opacityPercent"], 0, 100) * 1000))
            if cfg.get("dashStyle"):
                dash = str(cfg["dashStyle"])
                if dash not in {"solid", "dot", "dash", "lgDash", "dashDot", "sysDot", "sysDash"}:
                    raise ValueError(f"Unsupported dashStyle: {dash}")
                XML.SubElement(ln, tag(DRAWING, "prstDash"), val=dash)

    if any(k in operation for k in ("rotationDegrees", "flipH", "flipV")):
        transform = xml_child(properties, DRAWING, "xfrm", tuple(XML.QName(node).localname for node in properties if isinstance(node.tag, str)))
        if "rotationDegrees" in operation:
            transform.set("rot", str((bounded_integer(round(float(operation["rotationDegrees"])), -360, 360) % 360) * 60000))
        if "flipH" in operation:
            transform.set("flipH", "1" if operation["flipH"] else "0")
        if "flipV" in operation:
            transform.set("flipV", "1" if operation["flipV"] else "0")

    if any(k in operation for k in ("shadow", "glow", "softEdge")):
        if properties.find(tag(DRAWING, "effectDag")) is not None:
            raise ValueError("The shape has a protected effect graph")
        effects = xml_child(properties, DRAWING, "effectLst", ("scene3d", "sp3d", "extLst"))
        if "shadow" in operation:
            current = effects.find(tag(DRAWING, "outerShdw"))
            if current is not None:
                effects.remove(current)
            sh_val = operation["shadow"]
            if sh_val is True or isinstance(sh_val, dict):
                cfg = sh_val if isinstance(sh_val, dict) else {}
                blur = bounded_integer(round(float(cfg.get("blurPt", 3.0)) * 12700), 0, 1270000)
                dist = bounded_integer(round(float(cfg.get("distPt", 2.0)) * 12700), 0, 1270000)
                ang = (bounded_integer(round(float(cfg.get("angleDegrees", 45))), -360, 360) % 360) * 60000
                sh_color = str(cfg.get("color", "000000")).lstrip("#").upper()
                if not re.fullmatch(r"[0-9A-F]{6}", sh_color):
                    raise ValueError("Use a six-digit RGB color")
                sh_alpha = bounded_integer(cfg.get("opacityPercent", 35), 0, 100) * 1000
                shadow = XML.SubElement(effects, tag(DRAWING, "outerShdw"), blurRad=str(blur), dist=str(dist), dir=str(ang))
                shade = XML.SubElement(shadow, tag(DRAWING, "srgbClr"), val=sh_color)
                XML.SubElement(shade, tag(DRAWING, "alpha"), val=str(sh_alpha))
        if "glow" in operation:
            cur_g = effects.find(tag(DRAWING, "glow"))
            if cur_g is not None:
                effects.remove(cur_g)
            gl_val = operation["glow"]
            if isinstance(gl_val, dict):
                rad = bounded_integer(round(float(gl_val.get("radiusPt", 5.0)) * 12700), 1270, 1270000)
                gl_color = str(gl_val.get("color", "FFC000")).lstrip("#").upper()
                if not re.fullmatch(r"[0-9A-F]{6}", gl_color):
                    raise ValueError("Use a six-digit RGB color")
                gl_el = XML.SubElement(effects, tag(DRAWING, "glow"), rad=str(rad))
                srgb = XML.SubElement(gl_el, tag(DRAWING, "srgbClr"), val=gl_color)
                XML.SubElement(srgb, tag(DRAWING, "alpha"), val=str(bounded_integer(gl_val.get("opacityPercent", 60), 0, 100) * 1000))
        if "softEdge" in operation:
            cur_s = effects.find(tag(DRAWING, "softEdge"))
            if cur_s is not None:
                effects.remove(cur_s)
            se_val = operation["softEdge"]
            if isinstance(se_val, dict):
                rad = bounded_integer(round(float(se_val.get("radiusPt", 4.0)) * 12700), 1270, 1270000)
                XML.SubElement(effects, tag(DRAWING, "softEdge"), rad=str(rad))

    tx_body = shape.find(tag(PRESENTATION, "txBody"))
    if tx_body is not None:
        if "verticalAlign" in operation or isinstance(operation.get("marginsPt"), dict):
            body_pr = xml_child(tx_body, DRAWING, "bodyPr", ("lstStyle", "p"))
            if "verticalAlign" in operation:
                va_map = {"top": "t", "middle": "ctr", "center": "ctr", "bottom": "b"}
                va = str(operation["verticalAlign"])
                if va not in va_map:
                    raise ValueError(f"Unsupported verticalAlign: {va}")
                body_pr.set("anchor", va_map[va])
            if isinstance(operation.get("marginsPt"), dict):
                for key, attr in (("left", "lIns"), ("right", "rIns"), ("top", "tIns"), ("bottom", "bIns")):
                    if key in operation["marginsPt"]:
                        body_pr.set(attr, str(bounded_integer(round(float(operation["marginsPt"][key]) * 12700), 0, 1270000)))
        if any(k in operation for k in ("alignment", "level", "lineSpacingPercent", "spaceBeforePt", "spaceAfterPt", "bullet")):
            for para in tx_body.findall(tag(DRAWING, "p")):
                _apply_pptx_paragraph_props(para, operation)
        if any(k in operation for k in ("fontSizePt", "bold", "italic", "underline", "strikethrough", "strike", "fontFamily", "fontColor", "textColor")):
            for run in tx_body.iter(tag(DRAWING, "r")):
                _apply_pptx_run_props(run, operation)


def ensure_pptx_notes(package, slide, replacements, additions):
    from pptx import Presentation as SlideDocument
    relation_path = f"ppt/slides/_rels/{PurePosixPath(slide).name}.rels"
    relationships = load_edit_part(package, replacements, additions, relation_path)
    notes = [resolve_relationship("ppt/slides", node.attrib["Target"]) for node in relationships
             if node.get("Type", "").endswith("/notesSlide")]
    if len(notes) == 1:
        return load_edit_part(package, replacements, additions, notes[0])
    if notes:
        raise ValueError("Ambiguous notes part")
    temporary = SlideDocument()
    factory_slide = temporary.slides.add_slide(temporary.slide_layouts[6])
    factory_slide.notes_slide.notes_text_frame.text = ""
    template_bytes = io.BytesIO()
    temporary.save(template_bytes)
    with zipfile.ZipFile(template_bytes) as template:
        document = load_edit_part(package, replacements, additions, MAIN_PART["pptx"])
        relationship_part = "ppt/_rels/presentation.xml.rels"
        pres_rels = load_edit_part(package, replacements, additions, relationship_part)
        masters = [resolve_relationship("ppt", node.attrib["Target"]) for node in pres_rels
                   if node.get("Type", "").endswith("/notesMaster")]
        if len(masters) > 1:
            raise ValueError("Ambiguous notes master")
        if masters:
            master = masters[0]
        else:
            original_master = "ppt/notesMasters/notesMaster1.xml"
            theme = next(target for kind, target in package_relationships(template, original_master).values()
                         if kind.endswith("/theme"))
            master = allocate_part(package, additions, "ppt/notesMasters/notesMaster", ".xml")
            master_rid = add_package_part(package, replacements, additions, MAIN_PART["pptx"], master,
                "notesMaster", "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
                template.read(original_master))
            master_list = xml_child(document, PRESENTATION, "notesMasterIdLst",
                                    ("handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz", "defaultTextStyle", "extLst"))
            XML.SubElement(master_list, tag(PRESENTATION, "notesMasterId")).set(tag(OFFICE_REL, "id"), master_rid)
            target_theme = allocate_part(package, additions, "ppt/theme/theme", ".xml")
            add_package_part(package, replacements, additions, master, target_theme,
                             "theme", "application/vnd.openxmlformats-officedocument.theme+xml", template.read(theme))

        part = allocate_part(package, additions, "ppt/notesSlides/notesSlide", ".xml")
        add_package_part(package, replacements, additions, slide, part, "notesSlide",
                         "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
                         template.read("ppt/notesSlides/notesSlide1.xml"))
        rels = XML.Element(tag(RELATIONSHIPS, "Relationships"))
        for index, kind, destination in ((1, "notesMaster", master), (2, "slide", slide)):
            XML.SubElement(rels, tag(RELATIONSHIPS, "Relationship"), Id=f"rId{index}", Type=OFFICE_REL + "/" + kind,
                           Target=posixpath.relpath(destination, "ppt/notesSlides"))
        additions[f"ppt/notesSlides/_rels/{PurePosixPath(part).name}.rels"] = XML.tostring(rels)
        return load_edit_part(package, replacements, additions, part)


def validate_draft_pptx_key(key):
    if not isinstance(key, str) or not re.fullmatch(r"pptx-structure:[1-9][0-9]{0,14}", key):
        raise ValueError("Invalid draft presentation identity")


def edit_presentation(package, operations, output):
    replacements = {}
    additions = {}
    draft_slides = {}
    draft_shapes = {}
    for operation in operations:
        op = operation["op"]
        draft_slide = operation.get("draftSlideKey")
        if draft_slide is not None:
            validate_draft_pptx_key(draft_slide)
        if op in {"pptx.add_slide", "pptx.reorder_slide", "pptx.remove_slide"}:
            created = pptx_edit_slide_list(package, replacements, additions, operation)
            if draft_slide is not None:
                if created is None or draft_slide in draft_slides:
                    raise ValueError("Invalid draft slide creation")
                draft_slides[draft_slide] = created
            continue
        if op.startswith("chart."):
            edit_chart(package, "pptx", operation, replacements)
            continue
        element_addition = op in {"pptx.add_shape", "pptx.add_image", "pptx.add_table"}
        if draft_slide is not None:
            if not element_addition or draft_slide not in draft_slides or "slidePart" in operation:
                raise ValueError("Unknown draft slide")
            slide = draft_slides[draft_slide]
        else:
            slide = operation["slidePart"]
        if not re.fullmatch(r"ppt/slides/[^/]+\.xml", slide):
            raise ValueError("Invalid slide part")
        root = load_edit_part(package, replacements, additions, slide)
        if op == "pptx.smartart.update_node_text":
            edit_smartart_text(package, operation, root, replacements)
            continue
        if op == "pptx.smartart.add_or_remove_node":
            edit_smartart_add_or_remove_node(package, operation, root, replacements, additions)
            continue
        tree = root.find(".//" + tag(PRESENTATION, "spTree"))
        if element_addition:
            shape_key = operation.get("draftShapeKey")
            if shape_key is not None:
                validate_draft_pptx_key(shape_key)
                if shape_key in draft_shapes:
                    raise ValueError("Duplicate draft shape")
            shape_id = pptx_append_shape(package, slide, tree, replacements, additions, operation)
            if shape_key is not None:
                draft_shapes[shape_key] = (slide, shape_id)
            continue
        if op == "pptx.group_shapes":
            pptx_group(tree, operation)
            continue
        if op == "pptx.set_notes":
            notes = ensure_pptx_notes(package, slide, replacements, additions)
            body = next((shape for shape in notes.iter(tag(PRESENTATION, "sp"))
                         if any(ph.get("type") == "body" for ph in shape.iter(tag(PRESENTATION, "ph")))), None)
            if body is None:
                raise ValueError("The slide has no editable notes placeholder")
            tx = body.find(tag(PRESENTATION, "txBody"))
            for para in list(tx.findall(tag(DRAWING, "p"))):
                tx.remove(para)
            for line in (operation["text"][:20_000].splitlines() or [""]):
                para = XML.SubElement(tx, tag(DRAWING, "p"))
                XML.SubElement(XML.SubElement(para, tag(DRAWING, "r")), tag(DRAWING, "t")).text = line
            continue

        found = find_pptx_shape_with_parent(tree, operation["shapeId"])
        if len(found) != 1:
            raise ValueError("Expected a unique shape matching shapeId")
        parent_tree, shape = found[0]

        if op == "pptx.set_shape_text":
            tx_body = shape.find(tag(PRESENTATION, "txBody"))
            if tx_body is None:
                if shape.tag != tag(PRESENTATION, "sp"):
                    raise ValueError("Shape has no editable text body")
                tx_body = XML.SubElement(shape, tag(PRESENTATION, "txBody"))
                XML.SubElement(tx_body, tag(DRAWING, "bodyPr"))
                XML.SubElement(tx_body, tag(DRAWING, "lstStyle"))
            _set_pptx_txbody_content(tx_body, operation)
        elif op == "pptx.set_shape_style":
            pptx_style(shape, operation)
        elif op == "pptx.remove_shape":
            parent_tree.remove(shape)
        elif op == "pptx.ungroup_shapes":
            if shape.tag != tag(PRESENTATION, "grpSp"):
                raise ValueError("Selected shape is not a group")
            g_xfrm = shape.find("./" + tag(PRESENTATION, "grpSpPr") + "/" + tag(DRAWING, "xfrm"))
            if g_xfrm is not None:
                off = g_xfrm.find(tag(DRAWING, "off"))
                ext = g_xfrm.find(tag(DRAWING, "ext"))
                ch_off = g_xfrm.find(tag(DRAWING, "chOff"))
                ch_ext = g_xfrm.find(tag(DRAWING, "chExt"))
                if None not in (off, ext, ch_off, ch_ext):
                    g_off = (int(off.attrib["x"]), int(off.attrib["y"]))
                    g_ext = (int(ext.attrib["cx"]), int(ext.attrib["cy"]))
                    g_ch_off = (int(ch_off.attrib["x"]), int(ch_off.attrib["y"]))
                    g_ch_ext = (int(ch_ext.attrib["cx"]), int(ch_ext.attrib["cy"]))
                    g_rot = int(g_xfrm.get("rot", "0")) / 60000.0
                    g_fh = g_xfrm.get("flipH") in ("1", "true")
                    g_fv = g_xfrm.get("flipV") in ("1", "true")
                    needs_transform = (g_off != g_ch_off or g_ext != g_ch_ext or g_rot != 0 or g_fh or g_fv)
                else:
                    needs_transform = False
            else:
                needs_transform = False
            offset = parent_tree.index(shape)
            children = [node for node in shape if node.find("./*/" + tag(PRESENTATION, "cNvPr")) is not None]
            for child in children:
                if needs_transform:
                    _pptx_ungroup_transform_child(child, g_off, g_ext, g_ch_off, g_ch_ext, g_rot, g_fh, g_fv)
                parent_tree.insert(offset, child)
                offset += 1
            parent_tree.remove(shape)
        elif op == "pptx.set_shape_bounds":
            box = operation["boundsPt"]
            if not isinstance(box, list) or len(box) != 4:
                raise ValueError("Expected x, y, width, and height in points")
            if not all(-14400 <= float(v) <= 14400 for v in box[:2]) or not all(1 <= float(v) <= 14400 for v in box[2:]):
                raise ValueError("Shape bounds out of range")
            x, y, width, height = [int(round(float(value) * 12700)) for value in box]
            transform = next((node for node in (
                shape.find("./" + tag(PRESENTATION, "spPr") + "/" + tag(DRAWING, "xfrm")),
                shape.find("./" + tag(PRESENTATION, "grpSpPr") + "/" + tag(DRAWING, "xfrm")),
                shape.find(tag(PRESENTATION, "xfrm")),
            ) if node is not None), None)
            if transform is None:
                sp_pr = shape.find(tag(PRESENTATION, "spPr")) or shape.find(tag(PRESENTATION, "grpSpPr"))
                if sp_pr is None:
                    raise ValueError("Shape has no spPr/grpSpPr for bounds")
                transform = xml_child(sp_pr, DRAWING, "xfrm", tuple(XML.QName(n).localname for n in sp_pr if isinstance(n.tag, str)))
            xml_child(transform, DRAWING, "off", ("ext", "chOff", "chExt")).attrib.update({"x": str(x), "y": str(y)})
            xml_child(transform, DRAWING, "ext", ("chOff", "chExt")).attrib.update({"cx": str(width), "cy": str(height)})
        elif op == "pptx.set_table_cell":
            table = shape.find(".//" + tag(DRAWING, "tbl"))
            if table is None:
                raise ValueError("The shape is not a table")
            rows = table.findall(tag(DRAWING, "tr"))
            cells = rows[bounded_integer(operation["row"], 0, len(rows) - 1)].findall(tag(DRAWING, "tc"))
            target = cells[bounded_integer(operation["column"], 0, len(cells) - 1)]
            tx_body = target.find(tag(DRAWING, "txBody"))
            if tx_body is None:
                tx_body = XML.SubElement(target, tag(DRAWING, "txBody"))
                XML.SubElement(tx_body, tag(DRAWING, "bodyPr"))
                XML.SubElement(tx_body, tag(DRAWING, "lstStyle"))
            if "text" in operation or "paragraphs" in operation:
                _set_pptx_txbody_content(tx_body, operation)
            if any(k in operation for k in ("fill", "backgroundColor", "verticalAlign")):
                tc_pr = xml_child(target, DRAWING, "tcPr")
                if "verticalAlign" in operation:
                    va_map = {"top": "t", "middle": "ctr", "center": "ctr", "bottom": "b"}
                    va = str(operation["verticalAlign"])
                    if va not in va_map:
                        raise ValueError("Invalid table cell verticalAlign")
                    tc_pr.set("anchor", va_map[va])
                bg = operation.get("backgroundColor", operation.get("fill"))
                if bg is not None:
                    for ch in list(tc_pr):
                        if isinstance(ch.tag, str) and XML.QName(ch).localname in {"noFill", "solidFill", "gradFill"}:
                            tc_pr.remove(ch)
                    cleaned = str(bg).lstrip("#")
                    if not re.fullmatch(r"[0-9A-Fa-f]{6}", cleaned):
                        raise ValueError("Use a six-digit RGB color")
                    sf = XML.SubElement(tc_pr, tag(DRAWING, "solidFill"))
                    XML.SubElement(sf, tag(DRAWING, "srgbClr"), val=cleaned.upper())
            if any(k in operation for k in ("alignment", "lineSpacingPercent", "spaceBeforePt", "spaceAfterPt")):
                for p_el in tx_body.findall(tag(DRAWING, "p")):
                    _apply_pptx_paragraph_props(p_el, operation)
            if any(k in operation for k in ("bold", "italic", "underline", "fontSizePt", "fontColor", "textColor", "fontFamily")):
                for r_el in tx_body.iter(tag(DRAWING, "r")):
                    _apply_pptx_run_props(r_el, operation)
        elif op == "pptx.move_shape":
            peers = [node for node in parent_tree if node.find("./*/" + tag(PRESENTATION, "cNvPr")) is not None]
            cur_idx = peers.index(shape)
            if "position" in operation:
                pos = str(operation["position"])
                if pos == "front":
                    index = len(peers) - 1
                elif pos == "back":
                    index = 0
                elif pos == "forward":
                    index = min(len(peers) - 1, cur_idx + 1)
                elif pos == "backward":
                    index = max(0, cur_idx - 1)
                else:
                    raise ValueError(f"Unsupported move position: {pos}")
            else:
                index = bounded_integer(operation["zOrder"], 0, len(peers) - 1)
            parent_tree.remove(shape)
            peers.remove(shape)
            if index < len(peers):
                parent_tree.insert(parent_tree.index(peers[index]), shape)
            else:
                extension = parent_tree.find(tag(PRESENTATION, "extLst"))
                parent_tree.insert(parent_tree.index(extension) if extension is not None else len(parent_tree), shape)
        else:
            raise ValueError("Unsupported presentation operation")
        replacements[slide] = root
    serialize_additions(package, replacements, additions, output, "pptx")
    return draft_shapes


SPREADSHEET_DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"


def append_chart_to_worksheet_drawing(original, generated, worksheet_part, old_drawing, new_drawing, new_names):
    old_rels = package_relationships(original, worksheet_part)
    new_rels = package_relationships(generated, worksheet_part)
    old_path = old_rels[old_drawing.attrib[tag(OFFICE_REL, "id")]][1]
    new_path = new_rels[new_drawing.attrib[tag(OFFICE_REL, "id")]][1]
    if old_path != new_path:
        raise ValueError("Chart creation would move the original worksheet drawing")
    old_part = parse_xml(original.read(old_path))
    new_part = parse_xml(generated.read(new_path))
    chart_rels = package_relationships(generated, new_path)
    matches = []
    for anchor in new_part:
        for chart in anchor.iter(tag(CHART, "chart")):
            relation_id = chart.attrib[tag(OFFICE_REL, "id")]
            if chart_rels[relation_id][1] in new_names:
                matches.append((anchor, chart))
    if len(matches) != 1:
        raise ValueError("Cannot isolate the new chart anchor")
    anchor, chart = matches[0]
    existing_ids = {node.get("id") for node in old_part.iter(tag(SPREADSHEET_DRAWING, "cNvPr"))}
    properties = next(anchor.iter(tag(SPREADSHEET_DRAWING, "cNvPr")), None)
    if properties is None:
        raise ValueError("New chart anchor has no shape identifier")
    if properties.get("id") in existing_ids:
        available = next(str(number) for number in range(1, len(existing_ids) + 2) if str(number) not in existing_ids)
        properties.set("id", available)
    old_part.append(anchor)
    return old_path, old_part, chart


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
            if drawing is None:
                raise ValueError("Chart creation produced no worksheet drawing")
            if old_drawing is not None:
                part, old_part, attachment = append_chart_to_worksheet_drawing(
                    original, generated, part, old_drawing, drawing, new_names
                )
            else:
                trailing = {"legacyDrawing", "legacyDrawingHF", "picture", "oleObjects", "controls",
                            "webPublishItems", "tableParts", "extLst"}
                offset = next((index for index, node in enumerate(old_part)
                               if isinstance(node.tag, str) and XML.QName(node).localname in trailing), len(old_part))
                old_part.insert(offset, drawing)
                attachment = drawing
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
            attachment = added[0].find(".//" + tag(CHART, "chart"))

        relation_id = attachment.attrib[tag(OFFICE_REL, "id")]
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
        used_ids = {element.get("Id") for element in merged_rels}
        if relation_id in used_ids:
            relation_id = next(f"rId{number}" for number in range(1, len(used_ids) + 2) if f"rId{number}" not in used_ids)
            attachment.set(tag(OFFICE_REL, "id"), relation_id)
            relation.set("Id", relation_id)
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


def alpha_from_black_white(black_path, white_path, output, dimensions, allow_empty=False, crop_to_ink=False):
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
    if alpha.getextrema() == (255, 255):
        raise ValueError("LibreOffice did not produce an isolatable sprite")
    if alpha.getbbox() is None:
        if allow_empty:
            metadata = PngImagePlugin.PngInfo()
            metadata.add_text("inkBoundsPt", json.dumps({"x": 0, "y": 0, "width": 0, "height": 0}))
            Image.new("RGBA", (1, 1) if crop_to_ink else alpha.size, (0, 0, 0, 0)).save(output, format="PNG", pnginfo=metadata)
            return
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
    sprite = Image.merge("RGBA", (*[straight(channel) for channel in black_channels], alpha))
    if crop_to_ink:
        sprite = sprite.crop((left, top, right, bottom))
    sprite.save(output, format="PNG", pnginfo=metadata)


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
    page_size_pt = (dimensions[0] / 12700.0, dimensions[1] / 12700.0)
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
        crop_png_region(output, request.get("region"), page_size_pt=page_size_pt)
        return
    target_id = str(request["shapeId"])
    if not _keep_shape_in_tree(tree, target_id):
        raise ValueError("Presentation shape was not found")
    solid_slide_background(slide, "000000")
    black = export_presentation_image(package, replacements, "sprite-black", dimensions)
    solid_slide_background(slide, "FFFFFF")
    white = export_presentation_image(package, replacements, "sprite-white", dimensions)
    alpha_from_black_white(black, white, output, dimensions, allow_empty=bool(request.get("allowEmpty") or request.get("cropSprite")), crop_to_ink=bool(request.get("cropSprite")))
    crop_png_region(output, request.get("region"), page_size_pt=page_size_pt)


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


def _render_office_pdf_with_bboxes(source, fmt, prefix="verification"):
    """Convert an Office file to PDF via LibreOffice and extract pdftotext -bbox XML if available."""
    if not shutil.which("libreoffice") or not shutil.which("pdftotext"):
        return None, None
    pdf_path = Path.cwd() / f"{prefix}.pdf"
    bbox_path = Path.cwd() / f"{prefix}-bounds.xhtml"
    try:
        render_office(source, pdf_path, {"format": fmt, "action": "export", "targetFormat": "pdf"})
        subprocess.run(["pdftotext", "-f", "1", "-l", "20", "-bbox", str(pdf_path), str(bbox_path)], check=True)
        root = XML.parse(str(bbox_path), XML.XMLParser(no_network=True, resolve_entities=False, load_dtd=False))
        return pdf_path, root.findall(".//{*}page")
    except (OSError, XML.XMLSyntaxError, subprocess.CalledProcessError):
        return None, None


def verify_office_render(source, fmt, result, finding, pages=None):
    if pages is None:
        _pdf, pages = _render_office_pdf_with_bboxes(source, fmt)
    if not pages:
        result("rendered_page_bounds", "unverified", "LibreOffice or pdftotext is unavailable, or no measurable pages were rendered.")
        return
    outside = 0
    word_count = 0
    for index, page in enumerate(pages):
        width, height = float(page.attrib["width"]), float(page.attrib["height"])
        for word in page.findall(".//{*}word"):
            word_count += 1
            x_min, y_min, x_max, y_max = (float(word.attrib[key]) for key in ("xMin", "yMin", "xMax", "yMax"))
            if x_min < -1 or y_min < -1 or x_max > width + 1 or y_max > height + 1:
                outside += 1
                finding("warning", "rendered_text_outside_page", f"page:{index + 1}", "A rendered glyph box extends past the page.")
    result("rendered_page_bounds", "failed" if outside else ("passed" if word_count else "passed"),
           f"Sampled {len(pages)} pages (limit 20), {word_count} word boxes, {outside} outside page bounds.")


def _estimate_text_height_pt(text, box_w_pt, font_size_pt):
    """Estimate wrapped text height in pt using Pillow font metrics (with CJK support)."""
    if not text.strip():
        return 0.0
    from PIL import Image, ImageDraw
    has_cjk = any(ord(ch) > 127 for ch in text)
    fnt = load_pil_font(max(8, int(round(font_size_pt * (96.0 / 72.0)))), cjk=has_cjk)
    draw = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    px_per_pt = 96.0 / 72.0
    max_px = max(12.0, box_w_pt * px_per_pt)
    total_lines = 0
    for para in text.splitlines() or [""]:
        if not para.strip():
            total_lines += 1
            continue
        line_w = 0.0
        lines_here = 1
        for token in re.findall(r"\S+\s*|\s+", para):
            tw = float(draw.textbbox((0, 0), token, font=fnt)[2])
            if line_w > 0 and line_w + tw > max_px:
                lines_here += 1
                line_w = tw
                if tw > max_px:
                    lines_here += int(tw // max_px)
                    line_w = tw % max_px
            else:
                line_w += tw
                if line_w > max_px:
                    lines_here += int(line_w // max_px)
                    line_w = line_w % max_px
        total_lines += lines_here
    return total_lines * font_size_pt * 1.25


def verify_pptx_text_overflow(package, main, pages, result, finding):
    """Verify PPTX text overflow using both font-metric shape fitting and LibreOffice rendered PDF word bboxes."""
    slides = presentation_slides(package, main)
    checked_shapes = 0
    overflow_shapes = 0
    for slide_idx, slide in enumerate(slides[:20]):
        content = parse_xml(package.read(slide["part"]))
        tree = content.find(".//" + tag(PRESENTATION, "spTree"))
        shape_boxes = []
        for sp in tree.findall(tag(PRESENTATION, "sp")):
            nv = sp.find("./" + tag(PRESENTATION, "nvSpPr") + "/" + tag(PRESENTATION, "cNvPr"))
            sid = nv.get("id") if nv is not None else "?"
            tx = sp.find(tag(PRESENTATION, "txBody"))
            if tx is None:
                continue
            full_text = "\n".join("".join(t.text or "" for t in p.iter(tag(DRAWING, "t"))) for p in tx.findall(tag(DRAWING, "p")))
            if not full_text.strip():
                continue
            transform = shape_transform(sp)
            if not transform or "geomBoundsPt" not in transform:
                continue
            geom = transform["geomBoundsPt"]
            box_w, box_h = geom["width"], geom["height"]
            body_pr = tx.find(tag(DRAWING, "bodyPr"))
            l_ins = int(body_pr.get("lIns", "91440")) / 12700.0 if body_pr is not None else 7.2
            r_ins = int(body_pr.get("rIns", "91440")) / 12700.0 if body_pr is not None else 7.2
            t_ins = int(body_pr.get("tIns", "45720")) / 12700.0 if body_pr is not None else 3.6
            b_ins = int(body_pr.get("bIns", "45720")) / 12700.0 if body_pr is not None else 3.6
            inner_w = max(4.0, box_w - l_ins - r_ins)
            inner_h = max(4.0, box_h - t_ins - b_ins)
            sz_vals = [int(rpr.get("sz")) / 100.0 for rpr in tx.iter(tag(DRAWING, "rPr")) if rpr.get("sz") and rpr.get("sz").isdigit()]
            font_pt = max(sz_vals) if sz_vals else 18.0
            checked_shapes += 1
            est_h = _estimate_text_height_pt(full_text, inner_w, font_pt)
            shape_boxes.append((sid, geom, full_text))
            has_norm_autofit = body_pr is not None and body_pr.find(tag(DRAWING, "normAutofit")) is not None
            if not has_norm_autofit and est_h > inner_h * 1.18:
                overflow_shapes += 1
                finding(
                    "warning", "pptx_text_overflow", f"{slide['part']}#{sid}",
                    f"Estimated text height ({est_h:.1f}pt at {font_pt:.0f}pt) exceeds shape inner height ({inner_h:.1f}pt).",
                )

        # Cross-check rendered PDF word boxes against enclosing shape bounds when LibreOffice PDF is available
        if pages and slide_idx < len(pages) and shape_boxes:
            for word in pages[slide_idx].findall(".//{*}word"):
                w_text = (word.text or "").strip()
                if not w_text:
                    continue
                wx0, wy0, wx1, wy1 = (float(word.attrib[k]) for k in ("xMin", "yMin", "xMax", "yMax"))
                wcx, wcy = (wx0 + wx1) / 2.0, (wy0 + wy1) / 2.0
                # Find any shape containing this word's token whose horizontal range overlaps
                matching = [
                    (sid, g) for sid, g, txt in shape_boxes
                    if w_text in txt and (g["x"] - 4 <= wcx <= g["x"] + g["width"] + 4)
                ]
                if len(matching) == 1:
                    sid, g = matching[0]
                    if wy1 > g["y"] + g["height"] + 3.0 or wx1 > g["x"] + g["width"] + 3.0:
                        if not any(i.get("code") == "pptx_text_overflow" and i.get("location") == f"{slide['part']}#{sid}" for i in []):
                            overflow_shapes += 1
                            finding(
                                "warning", "pptx_rendered_text_overflow", f"{slide['part']}#{sid}",
                                f"Rendered word '{w_text[:32]}' extends past shape bounds ({g['x']:.1f},{g['y']:.1f},{g['width']:.1f}x{g['height']:.1f}pt).",
                            )
    checked_slides = min(len(slides), 20)
    overflow_status = "failed" if overflow_shapes else ("unverified" if len(slides) > checked_slides else "passed")
    result(
        "text_overflow",
        overflow_status,
        f"Checked {checked_shapes} text shape(s) across {checked_slides}/{len(slides)} slide(s); overflow detections: {overflow_shapes}.",
    )


def verify_pptx_layer_visual_consistency(package, main, result, finding, verify_options=None):
    """Server-side layer-decomposition visual consistency check (background + sprites vs full LibreOffice slide PNG).
    Distinct from PR 3A's browser UI canvas visual fidelity gate.
    Supports arbitrary target slideIndices under bounded resource controls and never reports partial coverage as whole-document passed.
    """
    import time

    slides = presentation_slides(package, main)
    total_slides = len(slides)
    opts = verify_options if isinstance(verify_options, dict) else {}

    if not shutil.which("libreoffice"):
        slide_entries = [
            {"slideIndex": idx, "part": s["part"], "status": "unverified", "reason": "LibreOffice is unavailable."}
            for idx, s in enumerate(slides)
        ]
        result(
            "layer_visual_consistency",
            "unverified",
            f"LibreOffice is unavailable for server-side layer visual consistency check ({total_slides} slide(s) unverified).",
        )
        return {
            "verificationLayer": "server_side_layer_decomposition",
            "scope": "none",
            "totalSlides": total_slides,
            "targetSlides": [],
            "verifiedSlides": [],
            "failedSlides": [],
            "skippedByResourceLimitSlides": [],
            "unverifiedSlides": list(range(total_slides)),
            "minSsim": None,
            "maxMae": None,
            "slides": slide_entries,
        }

    raw_indices = opts.get("slideIndices")
    explicit_targets = None
    if raw_indices is not None:
        if not isinstance(raw_indices, list) or len(raw_indices) == 0:
            raise ValueError("verify options.slideIndices must be a non-empty list of slide indices")
        explicit_targets = []
        seen = set()
        for raw_idx in raw_indices:
            idx = bounded_integer(raw_idx, 0, max(0, total_slides - 1))
            if idx not in seen:
                seen.add(idx)
                explicit_targets.append(idx)

    max_slides = bounded_integer(opts.get("maxSlides", len(explicit_targets) if explicit_targets is not None else 5), 1, 50)
    max_shapes = bounded_integer(opts.get("maxShapesPerSlide", 20), 1, 100)
    max_total_sprites = 60
    time_budget_sec = 25.0
    target_order = explicit_targets if explicit_targets is not None else list(range(total_slides))
    target_set = set(target_order)

    from PIL import Image
    started_at = time.monotonic()
    sprites_rendered = 0
    executed_slides = 0
    slide_reports = {}

    for idx, slide in enumerate(slides):
        if idx not in target_set:
            slide_reports[idx] = {
                "slideIndex": idx,
                "part": slide["part"],
                "status": "unverified",
                "reason": "Not included in requested slideIndices.",
            }

    for slide_idx in target_order:
        slide = slides[slide_idx]
        content = parse_xml(package.read(slide["part"]))
        tree = content.find(".//" + tag(PRESENTATION, "spTree"))
        top_shapes = pptx_shape_order(tree)
        shape_count = len(top_shapes)

        if executed_slides >= max_slides:
            slide_reports[slide_idx] = {
                "slideIndex": slide_idx, "part": slide["part"], "status": "skipped_resource_limit",
                "shapeCount": shape_count, "reason": f"Reached maxSlides budget ({max_slides}).",
            }
            continue
        if shape_count > max_shapes:
            slide_reports[slide_idx] = {
                "slideIndex": slide_idx, "part": slide["part"], "status": "skipped_resource_limit",
                "shapeCount": shape_count, "reason": f"Slide has {shape_count} top-level shapes, exceeding maxShapesPerSlide ({max_shapes}).",
            }
            continue
        if sprites_rendered + shape_count > max_total_sprites and executed_slides > 0:
            slide_reports[slide_idx] = {
                "slideIndex": slide_idx, "part": slide["part"], "status": "skipped_resource_limit",
                "shapeCount": shape_count, "reason": f"Sprite render budget ({max_total_sprites}) would be exceeded.",
            }
            continue
        if (time.monotonic() - started_at) > time_budget_sec and executed_slides > 0:
            slide_reports[slide_idx] = {
                "slideIndex": slide_idx, "part": slide["part"], "status": "skipped_resource_limit",
                "shapeCount": shape_count, "reason": f"Verification time budget ({time_budget_sec:.0f}s) exceeded.",
            }
            continue

        executed_slides += 1
        try:
            full_png = Path.cwd() / f"vis-full-{slide_idx}.png"
            bg_png = Path.cwd() / f"vis-bg-{slide_idx}.png"
            render_presentation_layer(package, {"format": "pptx", "action": "render", "pageIndex": slide_idx}, full_png)
            render_presentation_layer(package, {"format": "pptx", "action": "render", "pageIndex": slide_idx, "variant": "background"}, bg_png)
            with Image.open(bg_png) as bg_img:
                composite = bg_img.convert("RGBA")
            slide_size_el = main.find(tag(PRESENTATION, "sldSz"))
            slide_w_pt = max(1.0, int(slide_size_el.get("cx", "9144000")) / 12700.0) if slide_size_el is not None else 720.0
            slide_h_pt = max(1.0, int(slide_size_el.get("cy", "6858000")) / 12700.0) if slide_size_el is not None else 540.0
            shape_regions = []
            for sh in top_shapes:
                sp_png = Path.cwd() / f"vis-sp-{slide_idx}-{sh['id']}.png"
                render_presentation_layer(
                    package,
                    {"format": "pptx", "action": "render", "pageIndex": slide_idx, "variant": "sprite", "shapeId": int(sh["id"]), "allowEmpty": True},
                    sp_png,
                )
                sprites_rendered += 1
                with Image.open(sp_png) as sp_img:
                    sp_rgba = sp_img.convert("RGBA")
                    ink_box = sp_rgba.getchannel("A").getbbox()
                    composite.alpha_composite(sp_rgba)
                    shape_regions.append((sh, ink_box))
            with Image.open(full_png) as ref_img:
                ref_rgb = ref_img.convert("RGB")
                comp_rgb = composite.convert("RGB")
                if ref_rgb.size != comp_rgb.size:
                    ref_rgb = ref_rgb.resize(comp_rgb.size, Image.Resampling.LANCZOS)
                ssim_val, mae_val = compute_image_ssim_and_mae(ref_rgb, comp_rgb)
                img_w, img_h = comp_rgb.size
                sx = img_w / slide_w_pt
                sy = img_h / slide_h_pt
                region_checks = []
                failed_regions = []
                for sh, ink_box in shape_regions:
                    geom = (sh.get("transform") or {}).get("geomBoundsPt") if isinstance(sh, dict) else None
                    x0, y0, x1, y1 = img_w, img_h, 0, 0
                    if isinstance(geom, dict) and geom.get("width", 0) > 0 and geom.get("height", 0) > 0:
                        x0 = min(x0, int(geom["x"] * sx) - 2)
                        y0 = min(y0, int(geom["y"] * sy) - 2)
                        x1 = max(x1, int((geom["x"] + geom["width"]) * sx) + 2)
                        y1 = max(y1, int((geom["y"] + geom["height"]) * sy) + 2)
                    if ink_box is not None:
                        x0 = min(x0, ink_box[0] - 2)
                        y0 = min(y0, ink_box[1] - 2)
                        x1 = max(x1, ink_box[2] + 2)
                        y1 = max(y1, ink_box[3] + 2)
                    x0 = max(0, min(img_w - 1, x0))
                    y0 = max(0, min(img_h - 1, y0))
                    x1 = max(x0 + 1, min(img_w, x1))
                    y1 = max(y0 + 1, min(img_h, y1))
                    if x1 - x0 < 2 or y1 - y0 < 2:
                        continue
                    r_ssim, r_mae = compute_image_ssim_and_mae(
                        ref_rgb.crop((x0, y0, x1, y1)),
                        comp_rgb.crop((x0, y0, x1, y1)),
                    )
                    ssim_applies = (x1 - x0) >= 8 and (y1 - y0) >= 8
                    r_ok = r_mae <= 10.0 and (not ssim_applies or r_ssim >= 0.85)
                    entry = {
                        "shapeId": sh["id"],
                        "name": sh.get("name", sh["id"]),
                        "bboxPx": [x0, y0, x1 - x0, y1 - y0],
                        "ssim": round(r_ssim, 4),
                        "mae": round(r_mae, 2),
                        "passed": r_ok,
                    }
                    region_checks.append(entry)
                    if not r_ok:
                        failed_regions.append(entry)
        except Exception as exc:
            slide_reports[slide_idx] = {
                "slideIndex": slide_idx, "part": slide["part"], "status": "failed",
                "shapeCount": shape_count, "reason": f"Layer render error: {exc}",
            }
            finding("error", "pptx_layer_visual_render_error", slide["part"], f"Failed rendering slide layers: {exc}")
            continue

        passed_slide = ssim_val >= 0.95 and mae_val <= 5.0 and len(failed_regions) == 0
        slide_reports[slide_idx] = {
            "slideIndex": slide_idx,
            "part": slide["part"],
            "status": "verified" if passed_slide else "failed",
            "shapeCount": shape_count,
            "ssim": round(ssim_val, 4),
            "mae": round(mae_val, 2),
            "regionChecks": region_checks,
            "failedRegionCount": len(failed_regions),
            "reason": (
                f"Layer composite matched full LibreOffice PNG across whole slide and {len(region_checks)} element bbox(es) (SSIM={ssim_val:.4f} >= 0.95, MAE={mae_val:.2f}/255)."
                if passed_slide else
                f"Layer composite diverged from full LibreOffice PNG (SSIM={ssim_val:.4f}, MAE={mae_val:.2f}/255, failedRegions={len(failed_regions)})."
            ),
        }
        if not passed_slide:
            finding(
                "warning", "pptx_layer_visual_mismatch", slide["part"],
                f"Layer-composited render diverged from full LibreOffice slide render (SSIM={ssim_val:.4f}, MAE={mae_val:.2f}, failedRegions={len(failed_regions)}).",
            )

    ordered_reports = [slide_reports[idx] for idx in range(total_slides)]
    verified_slides = [r["slideIndex"] for r in ordered_reports if r["status"] == "verified"]
    failed_slides = [r["slideIndex"] for r in ordered_reports if r["status"] == "failed"]
    skipped_slides = [r["slideIndex"] for r in ordered_reports if r["status"] == "skipped_resource_limit"]
    unverified_slides = [r["slideIndex"] for r in ordered_reports if r["status"] == "unverified"]
    measured = [r for r in ordered_reports if "ssim" in r]
    min_ssim = min((r["ssim"] for r in measured), default=None)
    max_mae = max((r["mae"] for r in measured), default=None)

    all_slides_verified = total_slides > 0 and len(verified_slides) == total_slides and not failed_slides
    if failed_slides:
        check_status = "failed"
    elif all_slides_verified:
        check_status = "passed"
    else:
        # Partial slide verification (either due to explicit slideIndices subset or resource limits)
        # MUST NOT be reported as whole-document passed.
        check_status = "unverified"

    scope = "full_deck" if all_slides_verified else ("selected_slides_partial" if explicit_targets is not None else "resource_bounded_partial")
    metric_text = f"min SSIM={min_ssim:.4f}, max MAE={max_mae:.2f}/255" if min_ssim is not None else "no slides rendered"
    result(
        "layer_visual_consistency",
        check_status,
        (
            f"Server-side layer-decomposition vs full LibreOffice PNG (distinct from PR 3A UI canvas check): "
            f"verified={verified_slides}, failed={failed_slides}, skipped_resource_limit={skipped_slides}, "
            f"unverified={unverified_slides} (total={total_slides}); {metric_text}."
        ),
    )
    return {
        "verificationLayer": "server_side_layer_decomposition",
        "scope": scope,
        "totalSlides": total_slides,
        "targetSlides": target_order,
        "verifiedSlides": verified_slides,
        "failedSlides": failed_slides,
        "skippedByResourceLimitSlides": skipped_slides,
        "unverifiedSlides": unverified_slides,
        "minSsim": min_ssim,
        "maxMae": max_mae,
        "slides": ordered_reports,
    }


def verify_docx_layout_quality(package, main, pdf_path, pages, result, finding):
    """Verify DOCX layout quality: printable margin overflow, oversized embeds, and blank pages."""
    body = main.find(tag(WORD, "body"))
    sections = list(body.iter(tag(WORD, "sectPr"))) if body is not None else []
    page_w_pt, page_h_pt = 612.0, 792.0
    left_pt, right_pt, top_pt, bottom_pt = 72.0, 72.0, 72.0, 72.0
    if sections:
        sec = sections[-1]
        pg_sz = sec.find(tag(WORD, "pgSz"))
        pg_mar = sec.find(tag(WORD, "pgMar"))
        if pg_sz is not None:
            page_w_pt = int(pg_sz.get(tag(WORD, "w"), "12240")) / 20.0
            page_h_pt = int(pg_sz.get(tag(WORD, "h"), "15840")) / 20.0
        if pg_mar is not None:
            left_pt = int(pg_mar.get(tag(WORD, "left"), "1440")) / 20.0
            right_pt = int(pg_mar.get(tag(WORD, "right"), "1440")) / 20.0
            top_pt = abs(int(pg_mar.get(tag(WORD, "top"), "1440"))) / 20.0
            bottom_pt = abs(int(pg_mar.get(tag(WORD, "bottom"), "1440"))) / 20.0
    printable_w = max(72.0, page_w_pt - left_pt - right_pt)
    printable_h = max(72.0, page_h_pt - top_pt - bottom_pt)

    oversized_embeds = 0
    for ext in main.iter("{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent"):
        cx_pt = int(ext.get("cx", "0")) / 12700.0
        cy_pt = int(ext.get("cy", "0")) / 12700.0
        if cx_pt > printable_w + 4.0 or cy_pt > printable_h + 4.0:
            oversized_embeds += 1
            finding(
                "warning", "docx_oversized_embed", "word/document.xml",
                f"Embedded drawing ({cx_pt:.1f}x{cy_pt:.1f}pt) exceeds printable body area ({printable_w:.1f}x{printable_h:.1f}pt).",
            )

    if not pages:
        result(
            "layout_quality",
            "failed" if oversized_embeds else "unverified",
            f"Checked OOXML embeds (oversized: {oversized_embeds}); LibreOffice PDF layout rendering was unavailable.",
        )
        return

    margin_overflows = 0
    blank_pages = 0
    for idx, page in enumerate(pages):
        pw, ph = float(page.attrib["width"]), float(page.attrib["height"])
        words = page.findall(".//{*}word")
        if not words and len(pages) > 1:
            blank_pages += 1
            finding("warning", "docx_blank_page", f"page:{idx + 1}", f"Rendered page {idx + 1} contains no text.")
        for word in words:
            wx0, wy0, wx1, wy1 = (float(word.attrib[k]) for k in ("xMin", "yMin", "xMax", "yMax"))
            # Ignore header/footer vertical zones when checking body horizontal margins
            if top_pt - 4 <= wy0 and wy1 <= ph - bottom_pt + 4:
                if wx0 < left_pt - 6.0 or wx1 > pw - right_pt + 6.0:
                    margin_overflows += 1
                    if margin_overflows <= 20:
                        finding(
                            "warning", "docx_margin_overflow", f"page:{idx + 1}",
                            f"Rendered text '{(word.text or '')[:32]}' extends outside printable horizontal margins.",
                        )
    layout_issues = oversized_embeds + margin_overflows + blank_pages
    result(
        "layout_quality",
        "failed" if layout_issues else "passed",
        f"Rendered {len(pages)} page(s); margin overflows: {margin_overflows}, blank pages: {blank_pages}, oversized embeds: {oversized_embeds}.",
    )


def verify_xlsx_text_truncation(package, source, result, finding):
    """Verify XLSX cell text clipping/truncation via column-width metrics and LibreOffice PDF ###/overflow inspection."""
    sheets = workbook_sheets(package)
    styles_root = parse_xml(package.read("xl/styles.xml")) if "xl/styles.xml" in package.namelist() else None
    wrapped_xfs = set()
    if styles_root is not None:
        cell_xfs = styles_root.find(tag(SPREADSHEET, "cellXfs"))
        if cell_xfs is not None:
            for idx, xf in enumerate(cell_xfs.findall(tag(SPREADSHEET, "xf"))):
                al = xf.find(tag(SPREADSHEET, "alignment"))
                if al is not None and al.get("wrapText") in ("1", "true"):
                    wrapped_xfs.add(str(idx))

    shared_strings = []
    if "xl/sharedStrings.xml" in package.namelist():
        ss_root = parse_xml(package.read("xl/sharedStrings.xml"))
        for si in ss_root.findall(tag(SPREADSHEET, "si")):
            shared_strings.append("".join(t.text or "" for t in si.iter(tag(SPREADSHEET, "t"))))

    checked_cells = 0
    clipped_cells = 0
    for sh in sheets:
        root = parse_xml(package.read(sh["part"]))
        col_widths = {}
        cols_el = root.find(tag(SPREADSHEET, "cols"))
        if cols_el is not None:
            for col in cols_el.findall(tag(SPREADSHEET, "col")):
                w = float(col.get("width", "8.43"))
                cmin = int(col.get("min", "1"))
                cmax = int(col.get("max", str(cmin)))
                for c_idx in range(cmin, min(cmax + 1, cmin + 500)):
                    col_widths[c_idx] = w
        fmt_pr = root.find(tag(SPREADSHEET, "sheetFormatPr"))
        default_w = float(fmt_pr.get("defaultColWidth", "8.43")) if fmt_pr is not None and fmt_pr.get("defaultColWidth") else 8.43

        occupied = set()
        cell_values = []
        for c in root.iter(tag(SPREADSHEET, "c")):
            addr = c.get("r")
            if not addr:
                continue
            r_num, c_num = cell_coordinates(addr)
            c_type = c.get("t")
            txt = ""
            if c_type == "inlineStr":
                txt = "".join(t.text or "" for t in c.iter(tag(SPREADSHEET, "t")))
            elif c_type == "s":
                v_txt = c.findtext(tag(SPREADSHEET, "v"))
                if v_txt and v_txt.isdigit() and int(v_txt) < len(shared_strings):
                    txt = shared_strings[int(v_txt)]
            else:
                txt = c.findtext(tag(SPREADSHEET, "v")) or ""
            if txt != "":
                occupied.add((r_num, c_num))
                cell_values.append((r_num, c_num, addr, c_type, c.get("s", "0"), txt))

        merged_spans = {}
        merges = root.find(tag(SPREADSHEET, "mergeCells"))
        if merges is not None:
            for mc in merges.findall(tag(SPREADSHEET, "mergeCell")):
                ref = mc.get("ref", "")
                if ":" in ref:
                    (r1, c1), (r2, c2) = bounded_sheet_range(ref)
                    merged_spans[(r1, c1)] = (r2, c2)

        for r_num, c_num, addr, c_type, s_idx, txt in cell_values:
            checked_cells += 1
            if s_idx in wrapped_xfs:
                continue
            span = merged_spans.get((r_num, c_num))
            end_c = span[1] if span else c_num
            avail_chars = sum(col_widths.get(c, default_w) for c in range(c_num, end_c + 1))
            # Count East Asian wide chars as 2.0 character units
            display_units = sum(2.0 if ord(ch) > 0x2E80 else 1.0 for ch in txt.splitlines()[0]) if txt else 0.0
            right_occupied = (r_num, end_c + 1) in occupied
            is_numeric = c_type in (None, "n")
            if (is_numeric and display_units > avail_chars + 1.5) or (right_occupied and display_units > avail_chars + 1.0):
                clipped_cells += 1
                finding(
                    "warning", "xlsx_text_truncation", f"{sh['name']}!{addr}",
                    f"Cell display width ({display_units:.1f} chars) exceeds column capacity ({avail_chars:.1f} chars){' with occupied neighbor' if right_occupied else ''}.",
                )

    hash_overflows = 0
    _pdf, pdf_pages = _render_office_pdf_with_bboxes(source, "xlsx", prefix="xlsx-verify")
    if pdf_pages:
        for p_idx, page in enumerate(pdf_pages):
            for word in page.findall(".//{*}word"):
                if re.fullmatch(r"#{3,}", (word.text or "").strip()):
                    hash_overflows += 1
                    finding("warning", "xlsx_rendered_hash_overflow", f"page:{p_idx + 1}", "LibreOffice rendered '###' numeric width overflow.")

    total_trunc = clipped_cells + hash_overflows
    result(
        "text_truncation",
        "failed" if total_trunc else "passed",
        f"Inspected {checked_cells} populated cell(s) across {len(sheets)} sheet(s); metric clipping: {clipped_cells}, LibreOffice '###' overflows: {hash_overflows}.",
    )


def verify_office(package, source, fmt, names, verify_options=None):
    issues = []
    checks = []
    extra_metrics = {}

    def result(identifier, status, evidence):
        checks.append({"id": identifier, "status": status, "evidence": evidence})

    def finding(severity, code, location, message):
        if len(issues) < 200:
            issues.append({"severity": severity, "code": code, "location": location, "message": message})

    result("package_structure", "passed", f"Validated {len(names)} archive entries, content types and internal relationship targets.")
    result("archive_security", "passed", "Checked archive limits, entry paths, encryption and XML document types.")
    external = 0
    active = 0
    missing_refs = 0
    main = parse_xml(package.read(MAIN_PART[fmt]))
    for part in sorted(names):
        if re.search(r"(^|/)(vbaproject\.bin|activex|embeddings)(/|$)", part, re.I):
            active += 1
        if part.endswith(".rels"):
            external += sum(node.get("TargetMode") == "External" for node in parse_xml(package.read(part)))
        if not part.endswith(".xml"):
            continue
        root = parse_xml(package.read(part))
        refs = {value for node in root.iter() for key, value in node.attrib.items()
                if key.startswith("{" + OFFICE_REL + "}") and value}
        if refs:
            rels = package_relationships(package, part)
            parent = PurePosixPath(part).parent
            rel_path = str(parent / "_rels" / (PurePosixPath(part).name + ".rels"))
            identifiers = set(rels)
            if rel_path in names:
                identifiers.update(node.get("Id") for node in parse_xml(package.read(rel_path)))
            for invalid in sorted(refs - identifiers):
                missing_refs += 1
                finding("error", "missing_xml_relationship", part, f"Relationship {invalid} is not defined for this part.")
    result("relationship_ids", "failed" if missing_refs else "passed", f"Unresolved XML relationship IDs: {missing_refs}.")
    if external or active:
        finding("warning", "active_or_external_content", MAIN_PART[fmt],
                f"External relationships: {external}. Macro, ActiveX or embedded entries: {active}.")
    result("active_content_scan", "passed",
           f"Counted {external} external relationships and {active} potentially active or embedded entries.")
    result("active_content_behavior", "unverified", "Executable behavior and embedded document contents were not evaluated.")

    safe_to_render = not (external or any(re.search(r"(^|/)(vbaproject\.bin|activex)(/|$)", part, re.I) for part in names))
    rendered_pdf = None
    rendered_pages = None
    if fmt in {"pptx", "docx"} and safe_to_render:
        rendered_pdf, rendered_pages = _render_office_pdf_with_bboxes(source, fmt)

    if fmt == "pptx":
        size = main.find(tag(PRESENTATION, "sldSz"))
        dimensions = (int(size.attrib["cx"]) / 12700, int(size.attrib["cy"]) / 12700)
        outside, overlaps, omitted = verify_slide_geometry(package, main, dimensions, finding)
        result("slide_bounds", "failed" if outside else ("unverified" if omitted else "passed"),
               f"Out-of-bounds top-level shapes: {outside}. Shapes without measurable bounds or inherited/group transforms: {omitted}.")
        result("shape_overlap", "failed" if overlaps else ("unverified" if omitted else "passed"),
               f"Top-level bounding boxes overlap in {overlaps} pairs. Intentional layering requires inspection.")
        verify_pptx_text_overflow(package, main, rendered_pages, result, finding)
        if safe_to_render:
            layer_summary = verify_pptx_layer_visual_consistency(
                package, main, result, finding, verify_options=verify_options,
            )
            if layer_summary is not None:
                extra_metrics["layerVisualConsistency"] = layer_summary
        else:
            slides = presentation_slides(package, main)
            result("layer_visual_consistency", "unverified", "Rendering skipped because package has external links or active content.")
            extra_metrics["layerVisualConsistency"] = {
                "verificationLayer": "server_side_layer_decomposition",
                "scope": "unverified_unsafe_package",
                "totalSlides": len(slides),
                "targetSlides": [],
                "verifiedSlides": [],
                "failedSlides": [],
                "skippedByResourceLimitSlides": [],
                "unverifiedSlides": list(range(len(slides))),
                "minSsim": None,
                "maxMae": None,
                "slides": [
                    {
                        "slideIndex": idx,
                        "part": slide["part"],
                        "status": "unverified",
                        "reason": "Rendering skipped because package has external links or active content.",
                    }
                    for idx, slide in enumerate(slides)
                ],
            }
    elif fmt == "docx":
        body = main.find(tag(WORD, "body"))
        sections = list(body.iter(tag(WORD, "sectPr"))) if body is not None else []
        bad = 0
        for index, section in enumerate(sections):
            size = section.find(tag(WORD, "pgSz"))
            margins = section.find(tag(WORD, "pgMar"))
            if size is None or margins is None:
                continue
            width, height = (int(size.get(tag(WORD, attr), "0")) for attr in ("w", "h"))
            left, right, top, bottom, gutter = (int(margins.get(tag(WORD, attr), "0")) for attr in
                                                ("left", "right", "top", "bottom", "gutter"))
            if width <= left + right + gutter or height <= abs(top) + abs(bottom):
                bad += 1
                finding("error", "invalid_page_area", f"section:{index + 1}", "Margins leave no positive area for body text.")
        result("section_dimensions", "failed" if bad else ("passed" if sections else "unverified"),
               f"Inspected geometry of {len(sections)} sections where page size and margins were specified.")
        verify_word_references(package, names, main, result, finding)
        verify_docx_layout_quality(package, main, rendered_pdf, rendered_pages, result, finding)
    elif fmt == "xlsx":
        verify_workbook_formulas(package, source, main, result, finding)
        if safe_to_render:
            verify_xlsx_text_truncation(package, source, result, finding)
        else:
            result("text_truncation", "unverified", "Rendering skipped because package has external links or active content.")
    if fmt in {"pptx", "docx"}:
        if not safe_to_render:
            result("rendered_page_bounds", "unverified", "Rendering was skipped because the package has external links or active content.")
        else:
            verify_office_render(source, fmt, result, finding, pages=rendered_pages)
    metrics = {"packageParts": len(names), **extra_metrics}
    return {"ok": not any(check["status"] == "failed" for check in checks),
            "coverage": "partial" if any(check["status"] == "unverified" for check in checks) else "complete",
            "checks": checks, "issues": issues, "metrics": metrics}


def verify_slide_geometry(package, root, size, finding):
    outside = overlaps = omitted = 0
    for slide in presentation_slides(package, root):
        content = parse_xml(package.read(slide["part"]))
        tree = content.find(".//" + tag(PRESENTATION, "spTree"))
        boxes = []
        for shape in pptx_shape_order(tree):
            transform = shape["transform"]
            if not transform or "geomBoundsPt" not in transform or shape["children"]:
                omitted += 1
                continue
            geom = transform["geomBoundsPt"]
            x, y, width, height = (geom[key] for key in ("x", "y", "width", "height"))
            radians = math.radians(transform["rotationDegrees"])
            half_width = (abs(math.cos(radians)) * width + abs(math.sin(radians)) * height) / 2
            half_height = (abs(math.sin(radians)) * width + abs(math.cos(radians)) * height) / 2
            box = ((x + width / 2 - half_width, y + height / 2 - half_height),
                   (x + width / 2 + half_width, y + height / 2 + half_height))
            if any(box[0][i] < -0.01 or box[1][i] > size[i] + 0.01 for i in (0, 1)):
                outside += 1
                finding("warning", "shape_outside_slide", f"{slide['part']}#{shape['id']}", "Shape bounds extend past the slide.")
            for other, other_box in boxes:
                if all(min(box[1][i], other_box[1][i]) - max(box[0][i], other_box[0][i]) > 0.5 for i in (0, 1)):
                    overlaps += 1
                    finding("warning", "shape_bounds_overlap", f"{slide['part']}#{other},{shape['id']}",
                            "Shape bounding rectangles intersect.")
            boxes.append((shape["id"], box))
    return outside, overlaps, omitted


def verify_word_references(package, names, root, result, finding):
    missing = 0
    for ref, part, element, attribute in (
        ("footnoteReference", "word/footnotes.xml", "footnote", "id"),
        ("endnoteReference", "word/endnotes.xml", "endnote", "id"),
        ("commentReference", "word/comments.xml", "comment", "id"),
    ):
        references = {child.get(tag(WORD, attribute)) for child in root.iter(tag(WORD, ref))}
        targets = {child.get(tag(WORD, attribute)) for child in
                   parse_xml(package.read(part)).iter(tag(WORD, element))} if part in names else set()
        for identifier in references - targets:
            missing += 1
            finding("error", "dangling_word_reference", part, f"Referenced {element} {identifier} is missing.")
    result("document_references", "failed" if missing else "passed",
           f"Missing footnote, endnote or comment targets referenced by the document body: {missing}.")


def verify_workbook_formulas(package, source, workbook, result, finding):
    from openpyxl.formula import Tokenizer
    from openpyxl.formula.tokenizer import TokenizerError
    sheets = workbook_sheets(package)
    sheet_names = {entry["name"].casefold() for entry in sheets}
    count = cached = errors = missing = unresolved = 0
    formula_cells = []

    def inspect_formula(expression, location):
        nonlocal missing, unresolved
        if not expression:
            unresolved += 1
            return
        try:
            tokens = Tokenizer("=" + expression.lstrip("=")).items
        except TokenizerError:
            unresolved += 1
            return
        for token in tokens:
            if token.value == "#REF!":
                reference = "#REF!"
            elif token.type == "OPERAND" and token.subtype == "RANGE" and "!" in token.value:
                reference = token.value.rsplit("!", 1)[0].strip("'").replace("''", "'")
                if "[" in reference or ":" in reference:
                    unresolved += 1
                    continue
                if reference.casefold() in sheet_names:
                    continue
            else:
                continue
            missing += 1
            finding("error", "invalid_formula_reference", location, f"Missing sheet or invalid reference: {reference}.")

    for sheet in sheets:
        root = parse_xml(package.read(sheet["part"]))
        for cell in root.iter(tag(SPREADSHEET, "c")):
            formula = cell.find(tag(SPREADSHEET, "f"))
            if formula is None:
                continue
            count += 1
            addr = cell.get("r")
            location = f"{sheet['name']}!{addr}"
            formula_cells.append((sheet["name"], addr))
            value = cell.findtext(tag(SPREADSHEET, "v"))
            if cell.get("t") == "e":
                errors += 1
                finding("error", "cached_formula_error", location, f"Cached formula error: {value or 'unknown'}.")
            elif value not in (None, ""):
                cached += 1
            inspect_formula(formula.text, location)
    for node in workbook.iter(tag(SPREADSHEET, "definedName")):
        inspect_formula(node.text, f"definedName:{node.get('name')}")
    result("formula_references", "failed" if missing else ("unverified" if unresolved else "passed"),
           f"Checked {count} cell formulas and defined names. Invalid references: {missing}. Unresolved expressions: {unresolved}.")
    result("formula_cache", "failed" if errors else "passed",
           f"Existing cached values: {cached}. Cached errors: {errors}. Formulas with no cached value: {count - cached - errors}.")

    if count == 0:
        result("formula_values", "passed", "Workbook contains no formulas.")
        return
    if not shutil.which("libreoffice") or not safe_to_evaluate_workbook(package):
        result("formula_values", "unverified", "LibreOffice evaluation was skipped (unavailable or workbook has external/macro/unsupported references).")
        return
    try:
        copy_path = Path.cwd() / "verify-eval-input.xlsx"
        copy_path.write_bytes(source.read_bytes())
        subprocess.run(
            ["libreoffice", "-env:UserInstallation=" + (Path.cwd() / "office-profile-eval").as_uri(),
             "--headless", "--convert-to", "xlsx", "--outdir", str(Path.cwd() / "eval-out"), str(copy_path)],
            check=True,
        )
        eval_path = Path.cwd() / "eval-out" / "verify-eval-input.xlsx"
        evaluated_lo = 0
        error_formula = 0
        unevaluated = 0
        with zipfile.ZipFile(eval_path) as eval_pkg:
            eval_sheets = {s["name"]: parse_xml(eval_pkg.read(s["part"])) for s in workbook_sheets(eval_pkg)}
            for sh_name, addr in formula_cells:
                sh_root = eval_sheets.get(sh_name)
                if sh_root is None:
                    unevaluated += 1
                    continue
                c_el = next((c for c in sh_root.iter(tag(SPREADSHEET, "c")) if c.get("r") == addr), None)
                if c_el is None:
                    unevaluated += 1
                elif c_el.get("t") == "e":
                    error_formula += 1
                    finding("error", "evaluated_formula_error", f"{sh_name}!{addr}",
                            f"LibreOffice evaluated formula error: {c_el.findtext(tag(SPREADSHEET, 'v')) or 'error'}.")
                elif c_el.findtext(tag(SPREADSHEET, "v")) not in (None, ""):
                    evaluated_lo += 1
                else:
                    unevaluated += 1
        result(
            "formula_values",
            "failed" if error_formula else ("unverified" if unevaluated else "passed"),
            f"Evaluated copy with LibreOffice: evaluated_lo={evaluated_lo}, error_formula={error_formula}, unevaluated_unsupported={unevaluated}, cached_existing={cached}.",
        )
    except (OSError, subprocess.CalledProcessError, zipfile.BadZipFile):
        result("formula_values", "unverified", "LibreOffice formula evaluation copy failed.")


CSS_URL = re.compile(r"""url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)""", re.I)
CSS_IMPORT = re.compile(r"""@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^'")\s;]+))\s*\)?\s*([^;]*);""", re.I)


def render_svg(request, source, output):
    if source.stat().st_size > 1_000_000:
        raise ValueError("SVG source exceeds the rendering limit")
    root = parse_xml(source.read_bytes())
    namespace = "http://www.w3.org/2000/svg"
    if root.tag != tag(namespace, "svg"):
        raise ValueError("Expected an SVG image")
    assets = {asset["relPath"]: asset for asset in request.get("assets", [])}
    entry = request.get("entry", "image.svg")
    expansion_budget = 64 * 1024 * 1024
    if len(assets) > 2000:
        raise ValueError("Too many SVG dependencies")

    def account_expansion(length):
        nonlocal expansion_budget
        expansion_budget -= length
        if expansion_budget < 0:
            raise ValueError("SVG dependencies exceed the expansion limit")

    def asset_at(parent, reference):
        parsed = urlsplit(reference)
        if parsed.scheme or parsed.netloc or not parsed.path or parsed.path.startswith("/"):
            return None
        relpath = posixpath.normpath(posixpath.join(posixpath.dirname(parent), unquote(parsed.path)))
        return assets.get(relpath)

    def read_asset(asset):
        sandbox_name = asset["sandboxName"]
        if not re.fullmatch(r"asset-[0-9]+", sandbox_name):
            raise ValueError("Invalid render attachment")
        return (source.parent / sandbox_name).read_bytes()

    def inline_url(parent, reference):
        if reference.startswith("#") or reference.lower().startswith(("data:image/", "data:font/")):
            return reference
        asset = asset_at(parent, reference)
        if not asset or not re.fullmatch(r"(?:image/(?:png|jpeg|gif|webp|bmp)|font/(?:woff2?|ttf|otf))", asset["mimeType"]):
            return ""
        raw = read_asset(asset)
        account_expansion((len(raw) + 2) // 3 * 4)
        data = base64.b64encode(raw).decode("ascii")
        return f"data:{asset['mimeType']};base64,{data}"

    def substitute_urls(parent, css):
        return CSS_URL.sub(lambda match: 'url("' + inline_url(parent, next(value for value in match.groups() if value)) + '")', css)

    def inline_styles(parent, css, ancestors):
        def import_css(match):
            reference = next(value for value in match.groups()[:3] if value)
            asset = asset_at(parent, reference)
            if not asset or not asset["relPath"].endswith(".css") or asset["relPath"] in ancestors or len(ancestors) >= 6:
                return ""
            raw = read_asset(asset)
            account_expansion(len(raw))
            imported = inline_styles(asset["relPath"], raw.decode("utf8"), ancestors | {asset["relPath"]})
            media = match[4].strip()
            return f"@media {media} {{ {imported} }}" if media else imported
        return substitute_urls(parent, CSS_IMPORT.sub(import_css, css))

    for node in root.iter():
        if node.tag in {tag(namespace, "image"), tag(namespace, "feImage")}:
            for key in ("href", "{http://www.w3.org/1999/xlink}href"):
                if key in node.attrib:
                    node.set(key, inline_url(entry, node.attrib[key]))
        if node.tag == tag(namespace, "style") and node.text:
            node.text = inline_styles(entry, node.text, {entry})
        for key, value in list(node.attrib.items()):
            if "url(" in value.lower():
                node.set(key, substitute_urls(entry, value))
    data = XML.tostring(root)
    if len(data) > 100 * 1024 * 1024:
        raise ValueError("SVG render payload exceeds the worker limit")
    subprocess.run(["rsvg-convert", "--keep-aspect-ratio", "-w", "2048", "-h", "2048", "-o", str(output)],
                   input=data, check=True)
    crop_png_region(output, request.get("region"))


def process_document(request, source, output):
    fmt = request["format"]
    if fmt == "image":
        return process_image(request, source, output)
    if fmt == "pdf":
        return process_pdf(request, source, output)
    if fmt == "media":
        return process_media(request, source, output)
    if fmt == "csv" and request["action"] == "render":
        render_csv_table(request, source, output)
        return None
    if fmt == "markdown" and request["action"] == "export":
        export_markdown(source, output, request["targetFormat"])
        return None
    if fmt == "svg" and request["action"] == "render":
        render_svg(request, source, output)
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
            return verify_office(package, source, fmt, names, verify_options=request.get("options"))
        if action == "pptx_draft_layer" and fmt == "pptx":
            with tempfile.TemporaryDirectory(prefix="pptx-draft-", dir=Path.cwd()) as scratch:
                draft_path = Path(scratch) / "draft.pptx"
                shapes = edit_presentation(package, request["operations"], draft_path)
                with zipfile.ZipFile(draft_path) as draft:
                    if request["variant"] == "sprite":
                        target = shapes.get(request["draftShapeKey"])
                        presentation = parse_xml(draft.read(MAIN_PART["pptx"]))
                        slides = presentation_slides(draft, presentation)
                        index = bounded_integer(request["pageIndex"], 0, len(slides) - 1)
                        if target is None or slides[index]["part"] != target[0]:
                            raise ValueError("Draft shape does not belong to the selected slide")
                        request = {**request, "shapeId": target[1], "cropSprite": True}
                    render_presentation_layer(draft, request, output)
            return None
        if action == "xlsx_draft_range" and fmt == "xlsx":
            with tempfile.TemporaryDirectory(prefix="xlsx-draft-", dir=Path.cwd()) as scratch:
                draft_path = Path(scratch) / "draft.xlsx"
                edit_workbook(package, request["operations"], draft_path)
                with zipfile.ZipFile(draft_path) as draft:
                    sheet = next((item for item in workbook_sheets(draft) if item["name"] == request["sheetName"]), None)
                    if sheet is None:
                        raise ValueError("Unknown draft worksheet")
                    options = {"sheetId": sheet["id"], "rangeA1": request["rangeA1"]}
                    result = read_workbook_range(draft, options, max_cells=8192)
                    result["cells"] = [cell for cell in result["cells"] if "formulaStatus" in cell]
                    for cell in result["cells"]:
                        cell.update(value=None, formulaStatus="unevaluated_unsupported")
                    if result["cells"]:
                        evaluate_workbook_range(draft, draft_path, options, result, max_cells=8192)
                    return result
        if action == "range" and fmt == "xlsx":
            options = request["range"]
            if "gridSearch" in options:
                return search_workbook_sheet(package, options)
            result = read_workbook_range(package, options)
            if options.get("evaluate") is True and any("formulaStatus" in cell for cell in result["cells"]):
                return evaluate_workbook_range(package, source, options, result)
            return result
        result = {"format": fmt, "packageParts": len(names),
                  "chartParts": sorted(name for name in names if re.fullmatch(r"(xl|ppt)/charts/[^/]+\.xml", name))}
        if fmt == "docx" and action in {"structure", "range"}:
            options = request.get("range", {})
            start = bounded_integer(options.get("start", 0), 0, 10_000_000)
            count = bounded_integer(options.get("count", 50), 1, 100)
            body_tag = tag(WORD, "body")
            numbering_formats = _word_ui_numbering_formats(package)
            blocks = []
            headings = []
            block_count = 0
            in_body = False
            body_depth = 0
            with package.open(MAIN_PART[fmt]) as doc_stream:
                for event, elem in XML.iterparse(
                    doc_stream, events=("start", "end"), resolve_entities=False, no_network=True,
                ):
                    if not in_body:
                        if event == "start" and elem.tag == body_tag:
                            in_body = True
                            body_depth = 0
                        continue
                    if event == "start":
                        body_depth += 1
                    elif event == "end":
                        if body_depth == 0 and elem.tag == body_tag:
                            in_body = False
                            break
                        if body_depth == 1:
                            if isinstance(elem.tag, str):
                                kind = _word_ui_paragraph_kind(elem, numbering_formats)
                                if "headingLevel" in kind:
                                    headings.append({"blockIndex": block_count, "text": text_content(elem, WORD), "level": kind["headingLevel"]})
                                if start <= block_count < start + count:
                                    simple = _word_ui_simple_paragraph(elem)
                                    block = {
                                        "blockIndex": block_count,
                                        "type": XML.QName(elem).localname,
                                        "text": _word_ui_text(elem) if simple else text_content(elem, WORD),
                                        "editableText": simple,
                                        **kind,
                                    }
                                    if simple:
                                        run = elem.find(tag(WORD, "r"))
                                        block.update(uiRuns=_word_ui_runs(elem), marks=_word_ui_marks(run) if run is not None else {})
                                    if block["type"] == "tbl":
                                        block["tableRows"] = _word_ui_table_rows(elem)
                                    blocks.append(block)
                                block_count += 1
                            elem.clear()
                            parent = elem.getparent()
                            if parent is not None:
                                while elem.getprevious() is not None:
                                    del parent[0]
                        body_depth -= 1
            if start > block_count:
                raise ValueError("Start block index exceeds document block count")
            related = {}
            for family, filename, element, key in (
                ("styles", "word/styles.xml", "style", "styleId"),
                ("numbering", "word/numbering.xml", "num", "numId"),
                ("footnotes", "word/footnotes.xml", "footnote", "id"),
            ):
                if filename in names:
                    entries = parse_xml(package.read(filename)).findall(tag(WORD, element))
                    related[family] = [entry.get(tag(WORD, key)) for entry in entries
                                       if family != "styles" or entry.get(tag(WORD, "type")) == "paragraph"][:1000]
            related["headersAndFooters"] = sorted(part for part in names if re.fullmatch(r"word/(?:header|footer)[0-9]+\.xml", part))
            return {
                **result,
                **related,
                "blockCount": block_count,
                "hasMore": start + len(blocks) < block_count,
                "blocks": blocks,
                "headings": headings,
            }
        main = parse_xml(package.read(MAIN_PART[fmt]))
        if fmt == "xlsx" and action == "structure":
            return {**result, "sheets": workbook_sheets(package)}
        if fmt == "pptx" and action in {"structure", "range"}:
            slides = presentation_slides(package, main)
            slide_parts = [slide["part"] for slide in slides]
            diagrams = sorted(name for name in names if re.fullmatch(r"ppt/diagrams/data[^/]+\.xml", name))
            if action == "structure":
                size = main.find(tag(PRESENTATION, "sldSz"))
                dimensions = None if size is None else {
                    "widthPt": int(size.get("cx")) / 12700, "heightPt": int(size.get("cy")) / 12700,
                }
                layouts = []
                for part in sorted(name for name in names if re.fullmatch(r"ppt/slideLayouts/slideLayout[0-9]+\.xml", name))[:500]:
                    layout = parse_xml(package.read(part))
                    common = layout.find(tag(PRESENTATION, "cSld"))
                    layouts.append({"part": part, "name": common.get("name", "") if common is not None else "",
                                    "type": layout.get("type", "")})
                return {**result, "slides": slides, "slideParts": slide_parts, "slideSize": dimensions,
                        "layouts": layouts, "smartArtParts": diagrams}
            part = request["range"]["part"]
            if part not in slide_parts and part not in diagrams:
                raise ValueError("Unknown slide or SmartArt part")
            root = parse_xml(package.read(part))
            if part in diagrams:
                drawing_root = None
                layout_root = None
                drawing_ids = [el.get("relId") for el in root.iter(tag(DIAGRAM_DRAWING, "dataModelExt"))]
                for sp_part in slide_parts:
                    rels = package_relationships(package, sp_part)
                    dm_rids = [rid for rid, (k, v) in rels.items() if k.endswith("/diagramData") and v == part]
                    if dm_rids:
                        if len(drawing_ids) == 1:
                            d_kind, d_part = rels.get(drawing_ids[0], ("", ""))
                            if d_kind.endswith("/diagramDrawing") and d_part in names:
                                drawing_root = parse_xml(package.read(d_part))
                        sp_xml = parse_xml(package.read(sp_part))
                        rel_el = next((el for el in sp_xml.iter(tag(DIAGRAM, "relIds")) if el.get(tag(OFFICE_REL, "dm")) == dm_rids[0]), None)
                        if rel_el is not None:
                            lo_rid = rel_el.get(tag(OFFICE_REL, "lo"))
                            l_kind, l_part = rels.get(lo_rid or "", ("", ""))
                            if l_kind.endswith("/diagramLayout") and l_part in names:
                                layout_root = parse_xml(package.read(l_part))
                        break
                classification = classify_smartart_layout(root, drawing_root, layout_root)
                return {
                    **result,
                    "part": part,
                    "layout": classification["layout"],
                    "layoutFamily": classification["family"],
                    "layoutEngine": classification["engine"],
                    "chMax": classification["chMax"],
                    "supportsNodeAddRemove": classification["supportsNodeAddRemove"],
                    "nodeAddRemoveReason": classification["reason"],
                    "nodes": [{"id": node.get("modelId"), "type": node.get("type"), "text": text_content(node, DRAWING)}
                              for node in root.iter(tag(DIAGRAM, "pt"))][:1000],
                    "connections": [dict(node.attrib) for node in root.iter(tag(DIAGRAM, "cxn"))][:1000],
                }
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
    except UnsupportedByFormatError as error:
        print(str(error), file=sys.stderr)
        sys.exit(4)
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, XML.LxmlError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
