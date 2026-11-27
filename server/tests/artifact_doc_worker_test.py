"""Real file round trips for the document worker.

Run using the Compact or Full runtime:
  /opt/agy-doc-runtime/venv/bin/python3 -m unittest discover -s server/tests -p artifact_doc_worker_test.py
"""

import base64
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
import zipfile

from docx import Document
from lxml import etree as XML
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.worksheet.formula import ArrayFormula
from PIL import Image, ImageChops, ImageStat
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
from pptx.util import Inches
from pypdf import PdfReader

WORKER = Path(__file__).resolve().parents[1] / "scripts/artifact_doc_worker.py"


class DocumentWorkerTest(unittest.TestCase):
    def setUp(self):
        staging = tempfile.TemporaryDirectory()
        self.addCleanup(staging.cleanup)
        self.directory = Path(staging.name)
        self.inputs = self.directory / "in"
        self.outputs = self.directory / "out"
        self.inputs.mkdir()
        self.outputs.mkdir()
        self.source = self.inputs / "document"
        self.result = self.outputs / "result"

    def run_worker(self, format_name, action, **arguments):
        request = {"format": format_name, "filename": f"test.{format_name}", "action": action, **arguments}
        (self.inputs / "request.json").write_text(json.dumps(request), encoding="utf-8")
        env = dict(os.environ, AGY_WORKER_IN_DIR=str(self.inputs), AGY_WORKER_OUT_DIR=str(self.outputs))
        self.result.unlink(missing_ok=True)
        subprocess.run([sys.executable, str(WORKER)], env=env, check=True, cwd=self.directory)
        return self.result.read_bytes()

    @unittest.skipUnless(shutil.which("rsvg-convert"), "SVG runtime not installed")
    def test_svg_renders_styles_and_images_supplied_by_the_snapshot(self):
        self.source.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">'
            '<style>@import "style/site.css";</style><rect width="20" height="20"/>'
            '<image x="0" y="0" width="2" height="2" href="assets/pixel.png"/></svg>',
            encoding="utf-8",
        )
        (self.inputs / "asset-0").write_text("rect{fill:#152b41}", encoding="utf-8")
        Image.new("RGB", (2, 2), (5, 6, 7)).save(self.inputs / "asset-1", "PNG")
        result = self.run_worker("svg", "render", entry="site/drawing.svg", assets=[
            {"relPath": "site/style/site.css", "mimeType": "text/css", "sandboxName": "asset-0"},
            {"relPath": "site/assets/pixel.png", "mimeType": "image/png", "sandboxName": "asset-1"},
        ])
        with Image.open(io.BytesIO(result)) as image:
            pixels = image.convert("RGB")
            self.assertEqual(pixels.getpixel((0, 0)), (5, 6, 7))
            self.assertEqual(pixels.getpixel((pixels.width // 2, pixels.height // 2)), (21, 43, 65))

    def test_pptx_edits_shapes_tables_and_slide_list(self):
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        slide.notes_slide.notes_text_frame.text = "Original notes"
        layout = str(slide.slide_layout.part.partname).lstrip("/")
        presentation.save(self.source)
        part = "ppt/slides/slide1.xml"
        result = self.run_worker("pptx", "edit", operations=[
            {"op": "pptx.add_shape", "slidePart": part, "kind": "rectangle", "boundsPt": [10, 20, 80, 60], "text": "A"},
            {"op": "pptx.set_shape_style", "slidePart": part, "shapeId": 2, "fill": "405060", "bold": True, "shadow": True},
            {"op": "pptx.set_shape_bounds", "slidePart": part, "shapeId": 2, "boundsPt": [20, 20, 80, 60]},
            {"op": "pptx.add_shape", "slidePart": part, "kind": "ellipse", "boundsPt": [100, 20, 80, 60], "text": "B"},
            {"op": "pptx.group_shapes", "slidePart": part, "shapeIds": [2, 3]},
            {"op": "pptx.add_table", "slidePart": part, "boundsPt": [20, 150, 200, 80], "rows": [["Before", "Value"]]},
            {"op": "pptx.set_table_cell", "slidePart": part, "shapeId": 5, "row": 0, "column": 0, "text": "After"},
            {"op": "pptx.set_notes", "slidePart": part, "text": "Updated notes"},
            {"op": "pptx.add_slide", "layoutPart": layout},
            {"op": "pptx.set_notes", "slidePart": "ppt/slides/slide2.xml", "text": "New notes"},
            {"op": "pptx.reorder_slide", "index": 1, "toIndex": 0},
        ])
        reopened = Presentation(io.BytesIO(result))
        self.assertEqual(len(reopened.slides), 2)
        self.assertEqual(len(reopened.slides[0].shapes), 0)
        self.assertEqual(reopened.slides[0].notes_slide.notes_text_frame.text, "New notes")
        self.assertEqual(len(reopened.slides[1].shapes[0].shapes), 2)
        self.assertEqual(reopened.slides[1].shapes[0].shapes[0].left.pt, 20)
        self.assertEqual(reopened.slides[1].shapes[1].table.cell(0, 0).text, "After")
        self.source.write_bytes(result)
        slide_range = json.loads(self.run_worker("pptx", "range", range={"part": part}))
        table = next(shape for shape in slide_range["shapes"] if "tableRows" in shape)
        self.assertEqual(table["tableRows"], [[
            {"text": "After", "editable": True}, {"text": "Value", "editable": True},
        ]])
        self.assertEqual(reopened.slides[1].notes_slide.notes_text_frame.text, "Updated notes")

    def test_pptx_creates_notes_master_when_presentation_has_none(self):
        presentation = Presentation()
        presentation.slides.add_slide(presentation.slide_layouts[6])
        presentation.save(self.source)
        result = self.run_worker("pptx", "edit", operations=[
            {"op": "pptx.set_notes", "slidePart": "ppt/slides/slide1.xml", "text": "Created"},
        ])
        self.assertEqual(Presentation(io.BytesIO(result)).slides[0].notes_slide.notes_text_frame.text, "Created")

    def test_docx_basic_edit_preserves_long_paragraphs_and_native_cell_properties(self):
        document = Document()
        paragraph = document.add_paragraph()
        for index in range(220):
            paragraph.add_run(f"[{index}]").bold = index % 2 == 0
        cell = document.add_table(rows=1, cols=1).cell(0, 0)
        cell.paragraphs[0].add_run("Styled cell").italic = True
        document.save(self.source)

        blocks = json.loads(self.run_worker("docx", "range", range={"start": 0, "count": 2}))["blocks"]
        self.assertTrue(blocks[0]["editableText"])
        self.assertEqual(len(blocks[0]["uiRuns"]), 220)
        self.assertTrue(blocks[1]["tableRows"][0][0]["editable"])
        long_text = "a" * 21_000 + "\n" + "Last line"
        specs = [{"originIndex": index, "text": run.text} for index, run in enumerate(paragraph.runs)]
        specs[0]["text"] = long_text
        result = self.run_worker("docx", "edit", operations=[
            {"op": "docx.set_paragraph_text", "blockIndex": 0, "preserveRunProperties": True, "runs": specs},
            {"op": "docx.set_table_cell", "blockIndex": 1, "row": 0, "column": 0,
             "text": "Updated styled cell", "preserveCellProperties": True},
        ])
        edited = Document(io.BytesIO(result))
        self.assertEqual(edited.paragraphs[0].runs[0].text, long_text)
        self.assertEqual(len(edited.paragraphs[0].runs), 220)
        self.assertTrue(edited.paragraphs[0].runs[0].bold)
        run = edited.tables[0].cell(0, 0).paragraphs[0].runs[0]
        self.assertEqual(run.text, "Updated styled cell")
        self.assertTrue(run.italic)

    def test_docx_edits_word_parts_and_preserves_unrelated_xml(self):
        document = Document()
        document.add_paragraph("Initial")
        document.save(self.source)
        picture = io.BytesIO()
        Image.new("RGB", (2, 2), (0, 128, 0)).save(picture, "PNG")
        result = self.run_worker("docx", "edit", operations=[
            {"op": "docx.patch_xml_text", "blockIndex": 0, "textIndex": 0, "expectedText": "Initial", "text": "Edited"},
            {"op": "docx.add_paragraph", "headingLevel": 2, "text": "Section"},
            {"op": "docx.set_list", "blockIndex": 0, "numberingId": 1},
            {"op": "docx.set_run_style", "blockIndex": 0, "runIndex": 0, "fontSizePt": 14, "bold": True},
            {"op": "docx.add_image", "blockIndex": 0, "imageBase64": base64.b64encode(picture.getvalue()).decode("ascii")},
            {"op": "docx.add_table", "rows": [["First", "Second"]]},
            {"op": "docx.set_table_cell", "blockIndex": 2, "row": 0, "column": 0, "text": "After"},
            {"op": "docx.add_header_footer", "kind": "header", "text": "New header"},
            {"op": "docx.edit_header_footer", "part": "word/header1.xml", "textIndex": 0, "text": "Edited header"},
            {"op": "docx.add_footnote", "blockIndex": 0, "text": "New footnote"},
            {"op": "docx.edit_footnote", "part": "word/footnotes.xml", "footnoteId": 1, "textIndex": 0, "text": "Edited footnote"},
        ])
        reopened = Document(io.BytesIO(result))
        self.assertEqual(reopened.paragraphs[0].text, "Edited")
        self.assertEqual(reopened.paragraphs[0].runs[0].font.size.pt, 14)
        self.assertTrue(reopened.paragraphs[0].runs[0].bold)
        self.assertEqual(reopened.paragraphs[1].style.style_id, "Heading2")
        self.assertEqual(reopened.tables[0].cell(0, 0).text, "After")
        self.assertEqual(reopened.sections[0].header.paragraphs[0].text, "Edited header")
        self.assertEqual(len(reopened.inline_shapes), 1)
        with zipfile.ZipFile(self.source) as original, zipfile.ZipFile(io.BytesIO(result)) as package:
            self.assertEqual(package.read("word/styles.xml"), original.read("word/styles.xml"))
            self.assertIn(b"Edited footnote", package.read("word/footnotes.xml"))
        self.source.write_bytes(result)
        report = json.loads(self.run_worker("docx", "verify"))
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["coverage"], "partial")

    def test_xlsx_edits_sheet_options_and_preserves_other_cells(self):
        book = Workbook()
        book.active["A1"] = "keep"
        book.save(self.source)
        part = "xl/worksheets/sheet1.xml"
        result = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.set_merge", "sheetPart": part, "range": "A1:B1"},
            {"op": "xlsx.add_conditional_format", "sheetPart": part, "range": "A2:A4", "minColor": "FF0000", "maxColor": "00FF00"},
            {"op": "xlsx.set_data_validation", "sheetPart": part, "range": "B2:B4", "kind": "list", "values": ["Yes", "No"]},
            {"op": "xlsx.set_auto_filter", "sheetPart": part, "range": "A2:B4", "column": 1, "values": ["Yes"]},
            {"op": "xlsx.set_page_setup", "sheetPart": part, "orientation": "landscape", "fitToWidth": 1},
            {"op": "xlsx.add_sheet", "name": "New worksheet"},
            {"op": "xlsx.set_cell", "sheetPart": "xl/worksheets/sheet2.xml", "address": "A1", "value": 4},
            {"op": "xlsx.set_defined_name", "sheetId": 2, "name": "ReportRange", "range": "A1:A2"},
            {"op": "xlsx.reorder_sheet", "sheetId": 2, "toIndex": 0},
        ])
        reopened = load_workbook(io.BytesIO(result))
        self.assertEqual(reopened.sheetnames, ["New worksheet", "Sheet"])
        self.assertEqual(reopened["New worksheet"]["A1"].value, 4)
        self.assertEqual(reopened["Sheet"]["A1"].value, "keep")
        self.assertIn("A1:B1", reopened["Sheet"].merged_cells)
        self.assertEqual(len(reopened["Sheet"].conditional_formatting), 1)
        self.assertEqual(reopened["Sheet"].data_validations.dataValidation[0].formula1, '"Yes,No"')
        self.assertEqual(reopened["Sheet"].auto_filter.filterColumn[0].filters.filter, ["Yes"])
        self.assertEqual(reopened["Sheet"].page_setup.orientation, "landscape")
        self.assertEqual(list(reopened.defined_names["ReportRange"].destinations), [("New worksheet", "$A$1:$A$2")])

    def test_xlsx_edits_cells_on_a_sheet_created_in_the_same_revision(self):
        workbook = Workbook()
        workbook.active["A1"] = "Original"
        workbook.save(self.source)
        alias = "grid-structure:1"
        edited = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.add_sheet", "name": "Draft", "draftSheetKey": alias},
            {"op": "xlsx.set_cell", "draftSheetKey": alias, "address": "A1", "value": "Existing"},
            {"op": "xlsx.mutate_rows", "draftSheetKey": alias, "index": 1, "count": 1, "mode": "insert"},
            {"op": "xlsx.set_cell", "draftSheetKey": alias, "address": "A1", "value": "Inserted"},
            {"op": "xlsx.set_cell_style", "draftSheetKey": alias, "address": "A1", "italic": True},
            {"op": "xlsx.rename_sheet", "draftSheetKey": alias, "name": "Completed"},
        ])
        reopened = load_workbook(io.BytesIO(edited))
        self.assertEqual(reopened.sheetnames, ["Sheet", "Completed"])
        self.assertEqual(reopened["Sheet"]["A1"].value, "Original")
        self.assertEqual(reopened["Completed"]["A1"].value, "Inserted")
        self.assertTrue(reopened["Completed"]["A1"].font.italic)
        self.assertEqual(reopened["Completed"]["A2"].value, "Existing")

    def test_xlsx_renames_references_and_removes_an_empty_sheet(self):
        book = Workbook()
        book.active.title = "Old Data"
        book.active["A1"] = 4
        book.create_sheet("Summary")["A1"] = "='Old Data'!A1"
        book.create_sheet("Unused")
        book.save(self.source)
        result = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.rename_sheet", "sheetId": 1, "name": "New Data"},
            {"op": "xlsx.remove_empty_sheet", "sheetId": 3},
        ])
        reopened = load_workbook(io.BytesIO(result))
        self.assertEqual(reopened.sheetnames, ["New Data", "Summary"])
        self.assertEqual(reopened["Summary"]["A1"].value, "='New Data'!A1")

    def test_verification_reports_structural_findings_and_unverified_checks(self):
        book = Workbook()
        book.active["A1"] = "=Missing!A2"
        book.active["B1"] = "=1+2"
        book.save(self.source)
        report = json.loads(self.run_worker("xlsx", "verify"))
        self.assertFalse(report["ok"])
        self.assertIn("invalid_formula_reference", [issue["code"] for issue in report["issues"]])
        check_map = {c["id"]: c["status"] for c in report["checks"]}
        self.assertEqual(check_map["formula_values"], "failed")
        self.assertIn(check_map["text_truncation"], ("passed", "failed"))
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(-1), Inches(1), Inches(3), Inches(2))
        slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(3), Inches(2))
        presentation.save(self.source)
        report = json.loads(self.run_worker("pptx", "verify"))
        self.assertFalse(report["ok"])
        self.assertIn("shape_outside_slide", [issue["code"] for issue in report["issues"]])
        self.assertIn("shape_bounds_overlap", [issue["code"] for issue in report["issues"]])
        pptx_checks = {c["id"]: c["status"] for c in report["checks"]}
        self.assertEqual(pptx_checks["text_overflow"], "passed")
        self.assertEqual(pptx_checks["layer_visual_consistency"], "passed")

    def test_xlsx_clears_formula_cache_and_all_chain_registrations(self):
        book = Workbook()
        book.active["A1"] = 1
        book.active["A2"] = "=A1+1"
        original = io.BytesIO()
        book.save(original)
        rels = "xl/_rels/workbook.xml.rels"
        types = "[Content_Types].xml"
        sheet = "xl/worksheets/sheet1.xml"
        chain = "xl/calcChain.xml"
        with zipfile.ZipFile(original) as source, zipfile.ZipFile(self.source, "w", zipfile.ZIP_DEFLATED) as updated:
            for name in source.namelist():
                payload = source.read(name)
                if name == rels:
                    node = XML.fromstring(payload)
                    XML.SubElement(node, f"{{{XML.QName(node).namespace}}}Relationship", Id="rCalcChain",
                                   Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain",
                                   Target="calcChain.xml")
                    payload = XML.tostring(node)
                if name == types:
                    node = XML.fromstring(payload)
                    XML.SubElement(node, f"{{{XML.QName(node).namespace}}}Override", PartName="/" + chain,
                                   ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml")
                    payload = XML.tostring(node)
                if name == sheet:
                    payload = payload.replace(b"<f>A1+1</f><v></v>", b"<f>A1+1</f><v>2</v>")
                updated.writestr(name, payload)
            updated.writestr(chain, '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="A2" i="1"/></calcChain>')
        values = json.loads(self.run_worker("xlsx", "range", range={"sheetId": "1", "rangeA1": "A1:A2"}))
        self.assertEqual(values["cells"][1]["formulaStatus"], "cached_existing")
        edited = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.set_cell", "sheetPart": sheet, "address": "A1", "value": 8},
        ])
        with zipfile.ZipFile(io.BytesIO(edited)) as package:
            self.assertNotIn(chain, package.namelist())
            self.assertNotIn(b"calcChain", package.read(rels))
            self.assertNotIn(b"calcChain", package.read(types))
        reopened = load_workbook(io.BytesIO(edited))
        self.assertEqual(reopened.active["A1"].value, 8)
        self.assertEqual(reopened.active["A2"].value, "=A1+1")
        self.assertTrue(reopened.calculation.fullCalcOnLoad)
        cached = load_workbook(io.BytesIO(edited), data_only=True)
        self.assertIsNone(cached.active["A2"].value)

    def test_spreadsheet_blank_cells_and_csv_export(self):
        book = Workbook()
        book.active["A1"] = "Value"
        book.save(self.source)
        result = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.set_cell", "sheetPart": "xl/worksheets/sheet1.xml", "address": "A2", "value": 4},
            {"op": "xlsx.set_cell", "sheetPart": "xl/worksheets/sheet1.xml", "address": "B2", "value": "new"},
        ])
        self.source.write_bytes(result)
        exported = self.run_worker("xlsx", "export", targetFormat="csv")
        self.assertEqual(exported.decode("utf-8").splitlines(), ["Value,", "4,new"])

    def test_spreadsheet_mutation_moves_cross_sheet_references(self):
        workbook = Workbook()
        detail = workbook.active
        detail.title = "Raw Data"
        detail["A1"], detail["A2"], detail["A3"] = 2, 5, 8
        detail["B3"] = "=SUM(A1:A3)"
        summary = workbook.create_sheet("Summary")
        summary["A1"] = "='Raw Data'!$A$2"
        summary["A2"] = "=SUM('Raw Data'!A1:A3)"
        workbook.save(self.source)
        result = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.mutate_rows", "sheetId": "1", "mode": "insert", "index": 2, "count": 2},
            {"op": "xlsx.mutate_columns", "sheetId": "1", "mode": "insert", "index": 1},
        ])
        reopened = load_workbook(io.BytesIO(result))
        self.assertEqual(reopened["Raw Data"]["B4"].value, 5)
        self.assertEqual(reopened["Raw Data"]["C5"].value, "=SUM(B1:B5)")
        self.assertEqual(reopened["Summary"]["A1"].value, "='Raw Data'!$B$4")
        self.assertEqual(reopened["Summary"]["A2"].value, "=SUM('Raw Data'!B1:B5)")

    def test_spreadsheet_mutation_refuses_array_formulas(self):
        workbook = Workbook()
        workbook.active["A1"] = ArrayFormula("A1:A3", "=ROW(A1:A3)")
        workbook.save(self.source)
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.run_worker("xlsx", "edit", operations=[
                {"op": "xlsx.mutate_rows", "sheetId": "1", "mode": "delete", "index": 2},
            ])
        self.assertEqual(failure.exception.returncode, 3)
        self.assertFalse(self.result.exists())

    def test_docx_preserves_header_and_changes_paragraph_and_page_size(self):
        document = Document()
        document.add_paragraph("Before")
        document.sections[0].header.paragraphs[0].text = "Protected header"
        document.save(self.source)
        result = self.run_worker("docx", "edit", operations=[
            {"op": "docx.set_paragraph_text", "blockIndex": 0, "text": "After"},
            {"op": "docx.set_page_size", "widthTwips": 15840, "heightTwips": 12240},
        ])
        reopened = Document(io.BytesIO(result))
        self.assertEqual(reopened.paragraphs[0].text, "After")
        self.assertEqual(reopened.sections[0].header.paragraphs[0].text, "Protected header")
        self.assertEqual(reopened.sections[0].page_width.twips, 15840)
        with zipfile.ZipFile(self.source) as before, zipfile.ZipFile(io.BytesIO(result)) as after:
            self.assertEqual(before.read("word/header1.xml"), after.read("word/header1.xml"))

    def test_pptx_persists_order_and_keeps_shape_identity(self):
        document = Presentation()
        slide = document.slides.add_slide(document.slide_layouts[1])
        slide.shapes.title.text = "Before"
        title_id = slide.shapes.title.shape_id
        document.save(self.source)
        filename = "ppt/slides/slide1.xml"
        result = self.run_worker("pptx", "edit", operations=[
            {"op": "pptx.set_shape_text", "slidePart": filename, "shapeId": title_id, "text": "After"},
            {"op": "pptx.move_shape", "slidePart": filename, "shapeId": title_id, "zOrder": 1},
        ])
        reopened = Presentation(io.BytesIO(result))
        self.assertEqual(reopened.slides[0].shapes[1].shape_id, title_id)
        self.assertEqual(reopened.slides[0].shapes[1].text, "After")

    @unittest.skipUnless(shutil.which("libreoffice"), "LibreOffice runtime not installed")
    def test_pptx_sprites_composite_over_the_background(self):
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        ids = []
        for offset, color in ((1, (0, 80, 150)), (2, (200, 60, 80))):
            shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(offset), Inches(1), Inches(3), Inches(2))
            shape.fill.solid()
            shape.fill.fore_color.rgb = RGBColor(*color)
            shape.rotation = 12
            ids.append(shape.shape_id)
        presentation.save(self.source)
        result = json.loads(self.run_worker("pptx", "range", range={"part": "ppt/slides/slide1.xml"}))
        self.assertEqual([layer["kind"] for layer in result["layers"]], ["master", "layout", "slide"])
        self.assertEqual([int(shape["id"]) for shape in result["shapes"]], ids)
        self.assertEqual(result["shapes"][0]["transform"]["geomBoundsPt"]["x"], 72)
        reference = Image.open(io.BytesIO(self.run_worker("pptx", "render"))).convert("RGB")
        composite = Image.open(io.BytesIO(self.run_worker("pptx", "render", variant="background"))).convert("RGBA")
        for shape_id in ids:
            sprite = Image.open(io.BytesIO(self.run_worker("pptx", "render", variant="sprite", shapeId=shape_id)))
            self.assertEqual(sprite.size, reference.size)
            self.assertEqual(sprite.mode, "RGBA")
            self.assertEqual(sprite.getpixel((0, 0))[3], 0)
            self.assertGreater(json.loads(sprite.info["inkBoundsPt"])["width"], 200)
            composite.alpha_composite(sprite)
        delta = ImageChops.difference(reference, composite.convert("RGB"))
        self.assertLess(max(ImageStat.Stat(delta).mean), 2.0)

    @unittest.skipUnless(os.environ.get("AGY_TEST_SMARTART_FILE"), "External SmartArt fixture not supplied")
    def test_real_smartart_updates_data_and_cached_drawing(self):
        # Apache POI test-data/slideshow/smartart-simple.pptx.
        shutil.copyfile(os.environ["AGY_TEST_SMARTART_FILE"], self.source)
        result = self.run_worker("pptx", "edit", operations=[{
            "op": "pptx.smartart.update_node_text",
            "slidePart": "ppt/slides/slide1.xml",
            "dataPart": "ppt/diagrams/data1.xml",
            "nodeId": "{63986E3B-5608-7F48-A1F2-C2D1F88EED58}",
            "text": "Juno",
        }])
        with zipfile.ZipFile(io.BytesIO(result)) as package:
            for part in ("ppt/diagrams/data1.xml", "ppt/diagrams/drawing1.xml"):
                self.assertIn(b"Juno", package.read(part))
        self.assertTrue(Presentation(io.BytesIO(result)).slides)
        if shutil.which("libreoffice"):
            self.source.write_bytes(result)
            pdf = self.run_worker("pptx", "export", targetFormat="pdf")
            self.assertIn("Juno", "".join(page.extract_text() for page in PdfReader(io.BytesIO(pdf)).pages))

    @unittest.skipUnless(shutil.which("libreoffice"), "LibreOffice runtime not installed")
    def test_calc_evaluates_only_a_copy(self):
        book = Workbook()
        book.active["A1"] = 4
        book.active["A2"] = "=SUM(A1,3)"
        book.save(self.source)
        original = self.source.read_bytes()
        result = json.loads(self.run_worker("xlsx", "range", range={"sheetId": "1", "rangeA1": "A2", "evaluate": True}))
        self.assertEqual(result["cells"][0]["formulaStatus"], "evaluated_lo")
        self.assertEqual(float(result["cells"][0]["value"]), 7.0)
        self.assertEqual(self.source.read_bytes(), original)

    def test_creates_combination_charts_with_a_secondary_axis(self):
        workbook = Workbook()
        workbook.active.append(["Category", "Price", "Count"])
        workbook.active.append(["One", 20, 5])
        workbook.active.append(["Two", 25, 1])
        workbook.save(self.source)
        sheet_chart = self.run_worker("xlsx", "edit", operations=[{
            "op": "chart.create", "kind": "combo", "sheetName": "Sheet", "dataRange": "B1:C3",
            "anchor": "E4", "categoryColumn": 1,
        }])
        self.assertEqual(len(load_workbook(io.BytesIO(sheet_chart)).active._charts), 1)
        self.source.write_bytes(sheet_chart)
        second_chart = self.run_worker("xlsx", "edit", operations=[{
            "op": "chart.create", "kind": "line", "sheetName": "Sheet", "dataRange": "C1:C3",
            "anchor": "E20", "categoryColumn": 1,
        }])
        self.assertEqual(len(load_workbook(io.BytesIO(second_chart)).active._charts), 2)

        presentation = Presentation()
        presentation.slides.add_slide(presentation.slide_layouts[6])
        presentation.save(self.source)
        slide_chart = self.run_worker("pptx", "edit", operations=[{
            "op": "chart.create", "kind": "combo", "pageIndex": 0, "categories": ["One", "Two"],
            "series": [{"name": "Price", "values": [20, 25]}, {"name": "Count", "values": [5, 1]}],
        }])
        self.assertTrue(Presentation(io.BytesIO(slide_chart)).slides[0].shapes[0].has_chart)
        for data, part in ((sheet_chart, "xl/charts/chart1.xml"), (slide_chart, "ppt/charts/chart1.xml")):
            with zipfile.ZipFile(io.BytesIO(data)) as package:
                root = XML.fromstring(package.read(part))
                self.assertEqual(len(root.xpath('//*[local-name()="valAx"]')), 2)
                self.assertEqual(len(root.xpath('//*[local-name()="lineChart"]')), 1)
                self.assertEqual(len(root.xpath('//*[local-name()="barChart"]')), 1)

    def test_xlsx_chart_updates_match_sheet_cells(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(["Category", "Series", "Second"])
        for category, value in (("A", 2), ("B", 5), ("C", 8)):
            sheet.append([category, value, value])
        chart = BarChart()
        chart.add_data(Reference(sheet, min_col=2, min_row=1, max_row=4), titles_from_data=True)
        chart.set_categories(Reference(sheet, min_col=1, min_row=2, max_row=4))
        sheet.add_chart(chart, "D2")
        workbook.save(self.source)
        chart_part = "xl/charts/chart1.xml"
        result = self.run_worker("xlsx", "edit", operations=[
            {"op": "chart.update_title_and_legend", "chartPart": chart_part, "title": "Updated", "legendPosition": "b"},
            {"op": "chart.update_series_data", "chartPart": chart_part, "seriesIndex": 0, "values": [3, 6, 9]},
            {"op": "chart.update_series_style", "chartPart": chart_part, "seriesIndex": 0, "color": "#336699"},
            {"op": "chart.add_or_remove_series", "chartPart": chart_part, "seriesIndex": 0, "mode": "add",
             "rangeFormula": "'Sheet'!$C$2:$C$4", "name": "Second", "values": [6, 12, 18]},
        ])
        reopened = load_workbook(io.BytesIO(result))
        self.assertEqual([reopened.active[f"B{row}"].value for row in range(2, 5)], [3, 6, 9])
        with zipfile.ZipFile(io.BytesIO(result)) as package:
            xml = package.read(chart_part)
            self.assertIn(b"Updated", xml)
            self.assertIn(b"336699", xml)
            parsed = XML.fromstring(xml)
            self.assertEqual(parsed.xpath('//*[local-name()="numCache"]//*[local-name()="v"]/text()'),
                             ["3", "6", "9", "6", "12", "18"])
        self.assertEqual([reopened.active[f"C{row}"].value for row in range(2, 5)], [6, 12, 18])

    def test_pptx_chart_updates_match_embedded_workbook(self):
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        data = CategoryChartData()
        data.categories = ["A", "B", "C"]
        data.add_series("Series", (2, 4, 6))
        slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1), Inches(5), Inches(3), data)
        presentation.save(self.source)
        chart_part = "ppt/charts/chart1.xml"
        result = self.run_worker("pptx", "edit", operations=[
            {"op": "chart.update_series_data", "chartPart": chart_part, "seriesIndex": 0,
             "values": [3, 5, 7], "categories": ["North", "South", "West"]},
        ])
        chart = Presentation(io.BytesIO(result)).slides[0].shapes[0].chart
        self.assertEqual(list(chart.series[0].values), [3, 5, 7])
        self.assertEqual([category.label for category in chart.plots[0].categories], ["North", "South", "West"])
        with zipfile.ZipFile(io.BytesIO(result)) as package:
            workbook_part = next(name for name in package.namelist() if name.endswith(".xlsx"))
            book = load_workbook(io.BytesIO(package.read(workbook_part)))
            self.assertEqual([book.active[f"B{row}"].value for row in range(2, 5)], [3, 5, 7])
            self.assertEqual([book.active[f"A{row}"].value for row in range(2, 5)], ["North", "South", "West"])

    def test_pdf_annotation_and_rotation(self):
        self.source.write_bytes(self.run_worker("pdf", "create", params={"pages": ["First", "Second"]}))
        result = self.run_worker("pdf", "edit", operations=[
            {"op": "pdf.add_note", "pageIndex": 0, "rect": [30, 30, 50, 50], "text": "Memo"},
            {"op": "pdf.rotate_page", "pageIndex": 0, "degrees": 90},
            {"op": "pdf.reorder_pages", "order": [1, 0]},
        ])
        document = PdfReader(io.BytesIO(result))
        self.assertIn("Second", document.pages[0].extract_text())
        self.assertIn("First", document.pages[1].extract_text())
        self.assertEqual(document.pages[1].rotation, 90)
        self.assertEqual(document.pages[1]["/Annots"][0].get_object()["/Contents"], "Memo")
        if shutil.which("pdftoppm"):
            self.source.write_bytes(result)
            with Image.open(io.BytesIO(self.run_worker("pdf", "render", pageIndex=0))) as page:
                self.assertEqual(page.format, "PNG")

    def test_pdf_reordering_preserves_catalog_and_page_references(self):
        from pypdf import PdfWriter
        from pypdf.annotations import Link
        from pypdf.generic import ArrayObject, DictionaryObject, NameObject
        from reportlab.pdfgen.canvas import Canvas

        document = io.BytesIO()
        canvas = Canvas(document)
        canvas.drawString(100, 700, "First")
        canvas.acroForm.textfield(name="memo", value="Keep me", x=100, y=600)
        canvas.showPage()
        canvas.drawString(100, 700, "Second")
        canvas.showPage()
        canvas.save()
        writer = PdfWriter(clone_from=PdfReader(io.BytesIO(document.getvalue())))
        writer.add_outline_item("First destination", 0)
        writer.add_attachment("data.txt", b"Attachment")
        writer.add_metadata({"/Title": "Document title"})
        writer.add_annotation(0, Link(rect=(10, 10, 30, 30), target_page_index=1))
        writer.root_object[NameObject("/OCProperties")] = DictionaryObject({
            NameObject("/OCGs"): ArrayObject([]),
            NameObject("/D"): DictionaryObject({NameObject("/BaseState"): NameObject("/ON")}),
        })
        writer.write(self.source)
        before_png = self.run_worker("pdf", "render", pageIndex=1) if shutil.which("pdftoppm") else None
        result = self.run_worker("pdf", "edit", operations=[
            {"op": "pdf.reorder_pages", "order": [1, 0]},
            {"op": "pdf.add_note", "pageIndex": 1, "rect": [40, 40, 60, 60], "text": "After reorder"},
        ])
        reordered = PdfReader(io.BytesIO(result))
        self.assertIn("Second", reordered.pages[0].extract_text())
        self.assertIn("First", reordered.pages[1].extract_text())
        self.assertEqual(reordered.get_destination_page_number(reordered.outline[0]), 1)
        annotations = [ref.get_object() for ref in reordered.pages[1]["/Annots"]]
        link = next(annotation for annotation in annotations if annotation["/Subtype"] == "/Link")
        self.assertEqual(link["/Dest"][0], reordered.pages[0].indirect_reference)
        self.assertTrue(any(annotation.get("/Contents") == "After reorder" for annotation in annotations))
        self.assertEqual(reordered.get_fields()["memo"]["/V"], "Keep me")
        self.assertEqual(reordered.attachments["data.txt"], [b"Attachment"])
        self.assertEqual(reordered.metadata.title, "Document title")
        self.assertEqual(reordered.root_object["/OCProperties"]["/D"]["/BaseState"], "/ON")
        if before_png is not None:
            self.source.write_bytes(result)
            after_png = self.run_worker("pdf", "render", pageIndex=0)
            with Image.open(io.BytesIO(before_png)) as before, Image.open(io.BytesIO(after_png)) as after:
                self.assertIsNone(ImageChops.difference(before, after).getbbox())

    def test_xlsx_cell_input_preserves_explicit_text_and_rejects_precision_loss(self):
        workbook = Workbook()
        workbook.active["A1"] = "00123"
        workbook.save(self.source)
        sheet_part = "xl/worksheets/sheet1.xml"
        result = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.set_cell", "sheetPart": sheet_part, "address": "A1", "value": "9007199254740993"},
            {"op": "xlsx.set_cell", "sheetPart": sheet_part, "address": "A2", "value": "00123"},
            {"op": "xlsx.set_cell", "sheetPart": sheet_part, "address": "A3", "value": "1.2345e-12", "valueType": "number"},
            {"op": "xlsx.set_cell", "sheetPart": sheet_part, "address": "A4", "value": False},
            {"op": "xlsx.set_cell", "sheetPart": sheet_part, "address": "A5", "value": ""},
        ])
        sheet = load_workbook(io.BytesIO(result)).active
        self.assertEqual((sheet["A1"].data_type, sheet["A1"].value), ("s", "9007199254740993"))
        self.assertEqual((sheet["A2"].data_type, sheet["A2"].value), ("s", "00123"))
        self.assertEqual((sheet["A3"].data_type, sheet["A3"].value), ("n", 1.2345e-12))
        self.assertEqual((sheet["A4"].data_type, sheet["A4"].value), ("b", False))
        self.assertEqual((sheet["A5"].data_type, sheet["A5"].value), ("s", ""))
        original = self.source.read_bytes()
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_worker("xlsx", "edit", operations=[
                {"op": "xlsx.set_cell", "sheetPart": sheet_part, "address": "A1", "value": "9007199254740993", "valueType": "number"},
            ])
        self.assertEqual(self.source.read_bytes(), original)
        self.assertFalse(self.result.exists())

    def test_pdf_merges_source_pages_without_rewriting_sources(self):
        first = self.run_worker("pdf", "create", params={"pages": ["One"]})
        second = self.run_worker("pdf", "create", params={"pages": ["Two", "Three"]})
        (self.inputs / "merge-0.pdf").write_bytes(first)
        (self.inputs / "merge-1.pdf").write_bytes(second)
        merged = self.run_worker("pdf", "create", params={}, mergeSourceCount=2)
        pages = PdfReader(io.BytesIO(merged)).pages
        self.assertEqual([page.extract_text().strip() for page in pages], ["One", "Two", "Three"])
        self.assertEqual((self.inputs / "merge-0.pdf").read_bytes(), first)
        self.assertEqual((self.inputs / "merge-1.pdf").read_bytes(), second)

    @unittest.skipUnless(shutil.which("ffprobe") and shutil.which("ffmpeg"), "FFmpeg runtime not installed")
    def test_media_trim_reports_the_new_audio_duration(self):
        with wave.open(str(self.source), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x00" * 8000)
        source = json.loads(self.run_worker("media", "structure", filename="sample.wav"))
        self.assertAlmostEqual(source["durationSeconds"], 1.0)
        result = self.run_worker("media", "edit", filename="sample.wav", operations=[
            {"op": "media.trim", "startSeconds": 0.2, "endSeconds": 0.6},
        ])
        with wave.open(io.BytesIO(result)) as audio:
            self.assertAlmostEqual(audio.getnframes() / audio.getframerate(), 0.4, places=2)

    def test_image_composites_an_overlay_at_its_selected_position(self):
        Image.new("RGBA", (7, 5), (255, 0, 0, 255)).save(self.source, format="PNG")
        overlay = io.BytesIO()
        Image.new("RGBA", (2, 2), (0, 0, 255, 255)).save(overlay, format="PNG")
        edited = self.run_worker("image", "edit", operations=[{
            "op": "image.composite", "x": 3, "y": 2, "imageBase64": base64.b64encode(overlay.getvalue()).decode("ascii"),
        }])
        with Image.open(io.BytesIO(edited)) as image:
            self.assertEqual(image.getpixel((3, 2)), (0, 0, 255, 255))
            self.assertEqual(image.getpixel((0, 0)), (255, 0, 0, 255))

    def test_image_crop_and_convert(self):
        Image.new("RGB", (12, 6), "red").save(self.source, format="PNG")
        result = self.run_worker("image", "edit", operations=[
            {"op": "image.crop", "left": 2, "top": 1, "right": 10, "bottom": 5},
            {"op": "image.rotate", "degrees": 90},
        ])
        self.source.write_bytes(result)
        exported = self.run_worker("image", "export", targetFormat="webp")
        with Image.open(io.BytesIO(exported)) as image:
            self.assertEqual(image.size, (4, 8))
            self.assertEqual(image.format, "WEBP")

    def test_csv_table_png_render_and_region_crop(self):
        self.source.write_text("Name,Score,Note\nAlice,95,Pass\nBob,82,Pass\n", encoding="utf-8")
        full_png = self.run_worker("csv", "render", filename="scores.csv")
        cropped_png = self.run_worker(
            "csv", "render", filename="scores.csv",
            region={"x": 0.0, "y": 0.0, "width": 0.5, "height": 0.5, "unit": "norm"},
        )
        with Image.open(io.BytesIO(full_png)) as full_img, Image.open(io.BytesIO(cropped_png)) as crop_img:
            self.assertEqual(full_img.format, "PNG")
            self.assertEqual(crop_img.format, "PNG")
            self.assertLess(crop_img.width, full_img.width)
            self.assertLess(crop_img.height, full_img.height)

    def test_markdown_exports_real_docx_and_pdf(self):
        md = "# Quarterly Summary\n\n**Revenue** increased by `15%`.\n\n| Region | Sales |\n| --- | ---: |\n| East | 120 |\n| West | 98 |\n"
        self.source.write_text(md, encoding="utf-8")
        docx_bytes = self.run_worker("markdown", "export", filename="report.md", targetFormat="docx")
        doc = Document(io.BytesIO(docx_bytes))
        joined = "\n".join(p.text for p in doc.paragraphs)
        self.assertIn("Quarterly Summary", joined)
        self.assertGreaterEqual(len(doc.tables), 1)
        pdf_bytes = self.run_worker("markdown", "export", filename="report.md", targetFormat="pdf")
        reader = PdfReader(io.BytesIO(pdf_bytes))
        self.assertGreaterEqual(len(reader.pages), 1)
        self.assertIn("Quarterly Summary", reader.pages[0].extract_text() or "")

    def test_pptx_advanced_multi_run_rich_style_non_contiguous_group_and_scaled_ungroup(self):
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        s1 = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.5), Inches(0.5), Inches(2), Inches(1))
        p1 = s1.text_frame.paragraphs[0]
        p1.add_run().text = "First"
        p1.add_run().text = " Second"
        s2 = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(3.0), Inches(0.5), Inches(2), Inches(1))
        s2.text = "Middle"
        s3 = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(5.5), Inches(0.5), Inches(2), Inches(1))
        s3.text = "Third"
        tbl_shape = slide.shapes.add_table(2, 2, Inches(0.5), Inches(2.5), Inches(4), Inches(1.5))
        cell_p = tbl_shape.table.cell(0, 0).text_frame.paragraphs[0]
        cell_p.add_run().text = "RunA"
        cell_p.add_run().text = "RunB"
        prs.save(self.source)

        edited = self.run_worker("pptx", "edit", operations=[
            {"op": "pptx.set_shape_text", "slidePart": "ppt/slides/slide1.xml", "shapeId": s1.shape_id, "text": "Line 1\nLine 2"},
            {"op": "pptx.set_shape_style", "slidePart": "ppt/slides/slide1.xml", "shapeId": s1.shape_id,
             "fill": {"type": "gradient", "angleDegrees": 45, "stops": [{"posPercent": 0, "color": "1D4ED8"}, {"posPercent": 100, "color": "3B82F6"}]},
             "outline": {"color": "0F172A", "widthPt": 2, "dashStyle": "dash"},
             "fontColor": "FFFFFF", "alignment": "center", "glow": {"radiusPt": 4, "color": "F59E0B"}},
            {"op": "pptx.add_shape", "slidePart": "ppt/slides/slide1.xml", "kind": "right_arrow", "boundsPt": [40, 320, 140, 50], "text": "Go"},
            {"op": "pptx.set_table_cell", "slidePart": "ppt/slides/slide1.xml", "shapeId": tbl_shape.shape_id,
             "row": 0, "column": 0, "text": "Cell L1\nCell L2", "fill": "DBEAFE", "bold": True},
            # Non-contiguous grouping (s1 and s3, skipping s2)
            {"op": "pptx.group_shapes", "slidePart": "ppt/slides/slide1.xml", "shapeIds": [s1.shape_id, s3.shape_id]},
        ])
        reopened = Presentation(io.BytesIO(edited))
        re_shapes = list(reopened.slides[0].shapes)
        grp = next(sh for sh in re_shapes if sh.shape_type == 6)
        self.assertEqual(len(grp.shapes), 2)
        self.assertTrue(any("Line 1" in sh.text and "Line 2" in sh.text for sh in grp.shapes))
        self.assertTrue(any(sh.has_text_frame and sh.text == "Go" for sh in re_shapes))
        # Scale the group's ext (2x width) and ungroup -> children must receive true affine transform!
        with zipfile.ZipFile(io.BytesIO(edited)) as zin, zipfile.ZipFile(self.source, "w") as zout:
            s_root = XML.fromstring(zin.read("ppt/slides/slide1.xml"))
            g_xfrm = s_root.find(".//{http://schemas.openxmlformats.org/presentationml/2006/main}grpSpPr/{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm")
            ext_el = g_xfrm.find("{http://schemas.openxmlformats.org/drawingml/2006/main}ext")
            ext_el.set("cx", str(int(ext_el.attrib["cx"]) * 2))
            for info in zin.infolist():
                zout.writestr(info, XML.tostring(s_root) if info.filename == "ppt/slides/slide1.xml" else zin.read(info.filename))
        ungrouped = self.run_worker("pptx", "edit", operations=[
            {"op": "pptx.ungroup_shapes", "slidePart": "ppt/slides/slide1.xml", "shapeId": grp.shape_id},
        ])
        after = Presentation(io.BytesIO(ungrouped))
        restored_s1 = next(sh for sh in after.slides[0].shapes if sh.shape_id == s1.shape_id)
        self.assertAlmostEqual(restored_s1.width / 914400.0, 4.0, places=1)

    def test_docx_advanced_multi_run_direct_style_auto_numbering_and_styled_table(self):
        doc = Document()
        p = doc.add_paragraph()
        p.add_run("PartA ")
        p.add_run("PartB")
        tbl = doc.add_table(rows=2, cols=2)
        cp = tbl.cell(0, 0).paragraphs[0]
        cp.add_run("One ")
        cp.add_run("Two")
        doc.save(self.source)

        edited = self.run_worker("docx", "edit", operations=[
            {"op": "docx.set_paragraph_text", "blockIndex": 0, "text": "Unified multi-run\nSecond line"},
            {"op": "docx.set_paragraph_style", "blockIndex": 0, "alignment": "center", "spaceBeforePt": 12,
             "spaceAfterPt": 6, "backgroundColor": "EFF6FF", "borders": {"bottom": {"color": "2563EB", "sizePt": 1.5}}},
            {"op": "docx.set_run_style", "blockIndex": 0, "bold": True, "underline": "single", "highlight": "yellow", "fontSizePt": 13},
            {"op": "docx.add_paragraph", "text": "Numbered heading", "headingLevel": 4, "listType": "decimal"},
            {"op": "docx.set_table_cell", "blockIndex": 1, "row": 0, "column": 0, "text": "Updated Cell", "backgroundColor": "FEF3C7", "bold": True},
        ])
        reopened = Document(io.BytesIO(edited))
        self.assertIn("Unified multi-run", reopened.paragraphs[0].text)
        self.assertIn("Second line", reopened.paragraphs[0].text)
        self.assertEqual(reopened.tables[0].cell(0, 0).text, "Updated Cell")
        with zipfile.ZipFile(io.BytesIO(edited)) as pkg:
            self.assertIn("word/numbering.xml", pkg.namelist())
            doc_xml = pkg.read("word/document.xml").decode("utf-8")
            self.assertIn("EFF6FF", doc_xml)
            self.assertIn("FEF3C7", doc_xml)
            self.assertIn("numPr", doc_xml)

        self.source.write_bytes(edited)
        result = json.loads(self.run_worker("docx", "range", range={"start": 2, "count": 1}))
        block = result["blocks"][0]
        self.assertEqual((block["text"], block["headingLevel"], block["listType"]), ("Numbered heading", 4, "decimal"))

    def test_xlsx_advanced_rich_cell_style_conditional_formats_validation_and_sheet_ops(self):
        wb = Workbook()
        ws = wb.active
        ws.title = "Metrics"
        ws["A1"] = "Item"
        ws["B1"] = "Value"
        ws["A2"] = "Alpha"
        ws["B2"] = 1200
        ws["A3"] = "Beta"
        ws["B3"] = 450
        wb.create_sheet("Lookup")["A1"] = "High"
        wb["Lookup"]["A2"] = "Low"
        wb.save(self.source)

        edited = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.set_cell_style", "sheetPart": "xl/worksheets/sheet1.xml", "range": "A1:B1",
             "bold": True, "fontColor": "FFFFFF", "backgroundColor": "1E3A8A",
             "border": {"style": "thin", "color": "CBD5E1"}, "horizontal": "center"},
            {"op": "xlsx.set_cell_style", "sheetPart": "xl/worksheets/sheet1.xml", "address": "B2", "numberFormat": "#,##0"},
            {"op": "xlsx.add_conditional_format", "sheetPart": "xl/worksheets/sheet1.xml", "range": "B2:B3",
             "type": "cellIs", "operator": "greaterThan", "value": 500, "style": {"backgroundColor": "DCFCE7", "bold": True}},
            {"op": "xlsx.add_conditional_format", "sheetPart": "xl/worksheets/sheet1.xml", "range": "B2:B3",
             "type": "dataBar", "color": "2563EB"},
            {"op": "xlsx.set_data_validation", "sheetPart": "xl/worksheets/sheet1.xml", "range": "C2:C3",
             "kind": "list", "formula": "=Lookup!$A$1:$A$2", "promptTitle": "Tier"},
            {"op": "xlsx.set_column_width", "sheetPart": "xl/worksheets/sheet1.xml", "column": "A", "width": 24},
            {"op": "xlsx.set_row_height", "sheetPart": "xl/worksheets/sheet1.xml", "row": 1, "height": 28},
            {"op": "xlsx.set_freeze_panes", "sheetPart": "xl/worksheets/sheet1.xml", "row": 1, "column": 0},
            {"op": "xlsx.duplicate_sheet", "sheetId": 1, "name": "Metrics Copy"},
        ])
        reopened = load_workbook(io.BytesIO(edited))
        self.assertEqual(reopened.sheetnames, ["Metrics", "Lookup", "Metrics Copy"])
        self.assertTrue(reopened["Metrics"]["A1"].font.bold)
        self.assertEqual(reopened["Metrics"]["B2"].number_format, "#,##0")
        self.assertEqual(reopened["Metrics"].freeze_panes, "A2")
        cf_rules = [rule for cf in reopened["Metrics"].conditional_formatting for rule in cf.rules]
        self.assertGreaterEqual(len(cf_rules), 2)
        self.assertEqual({rule.type for rule in cf_rules}, {"cellIs", "dataBar"})

        self.source.write_bytes(edited)
        record = json.loads(self.run_worker("xlsx", "range", range={"sheetId": "1", "rangeA1": "A1"}))["cells"][0]
        self.assertEqual({field: record[field] for field in ("bold", "fontColor", "backgroundColor", "horizontal")},
                         {"bold": True, "fontColor": "#ffffff", "backgroundColor": "#1e3a8a", "horizontal": "center"})

        # General non-empty sheet removal on the duplicated sheet
        after_rm = self.run_worker("xlsx", "edit", operations=[
            {"op": "xlsx.remove_sheet", "sheetId": 3},
        ])
        self.assertEqual(load_workbook(io.BytesIO(after_rm)).sheetnames, ["Metrics", "Lookup"])

    def test_pdf_structure_encryption_diff_verification_and_rich_overlays(self):
        v1 = self.run_worker("pdf", "create", params={"pages": ["Page one original", "Page two original"]})
        self.source.write_bytes(v1)
        struct = json.loads(self.run_worker("pdf", "structure"))
        self.assertEqual(struct["pageCount"], 2)
        self.assertFalse(struct["encrypted"])
        self.assertIn("pageContentHash", struct["pages"][0])

        # Rich overlays: multi-line text, highlight, rect, stamp, top-left origin
        v2 = self.run_worker("pdf", "edit", operations=[
            {"op": "pdf.add_overlay", "pageIndex": 0, "kind": "highlight", "rect": [30, 720, 220, 760], "color": "FEF08A", "opacity": 0.4},
            {"op": "pdf.add_overlay", "pageIndex": 0, "kind": "stamp", "rect": [350, 700, 520, 750], "text": "APPROVED", "rotationDegrees": -10},
            {"op": "pdf.add_overlay", "pageIndex": 0, "kind": "text", "rect": [36, 620, 300, 680],
             "text": "Multiline overlay\nSecond overlay line", "backgroundColor": "F8FAFC", "borderColor": "94A3B8"},
        ])
        self.source.write_bytes(v2)
        (self.inputs / "compare").write_bytes(v1)
        report = json.loads(self.run_worker("pdf", "verify", hasCompareDocument=True))
        self.assertTrue(report["ok"], json.dumps(report))
        check_ids = {c["id"]: c["status"] for c in report["checks"]}
        self.assertEqual(check_ids["pdf_structure"], "passed")
        self.assertEqual(check_ids["pdf_encryption"], "passed")
        self.assertEqual(check_ids["pdf_text_extraction"], "passed")
        self.assertEqual(check_ids["pdf_diff"], "passed")
        self.assertIn(1, report["metrics"]["diff"]["changedTextPages"])

        # Verify region crop on PDF render
        full_render = self.run_worker("pdf", "render", pageIndex=0)
        crop_render = self.run_worker("pdf", "render", pageIndex=0, region={"x": 0, "y": 0, "width": 200, "height": 150, "unit": "pt"})
        with Image.open(io.BytesIO(full_render)) as fimg, Image.open(io.BytesIO(crop_render)) as cimg:
            self.assertLess(cimg.width, fimg.width)
            self.assertLess(cimg.height, fimg.height)

        # Verify encrypted PDF detection without crashing
        from pypdf import PdfWriter
        enc_writer = PdfWriter(clone_from=PdfReader(io.BytesIO(v1)))
        enc_writer.encrypt(user_password="secret", owner_password="owner")
        enc_buf = io.BytesIO()
        enc_writer.write(enc_buf)
        self.source.write_bytes(enc_buf.getvalue())
        enc_report = json.loads(self.run_worker("pdf", "verify"))
        self.assertFalse(enc_report["ok"])
        self.assertEqual({c["id"]: c["status"] for c in enc_report["checks"]}["pdf_encryption"], "failed")

        # Verify pdf.delete_text returns exit code 4 (unsupported_by_format)
        self.source.write_bytes(v1)
        (self.inputs / "request.json").write_text(json.dumps({
            "format": "pdf", "filename": "test.pdf", "action": "edit",
            "operations": [{"op": "pdf.delete_text", "pageIndex": 0}],
        }), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(WORKER)],
            env=dict(os.environ, AGY_WORKER_IN_DIR=str(self.inputs), AGY_WORKER_OUT_DIR=str(self.outputs)),
            cwd=self.directory, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 4)

    def test_office_verification_detects_pptx_overflow_docx_layout_and_xlsx_truncation(self):
        # 1. PPTX text overflow detection + server-side layer SSIM check
        prs = Presentation()
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        tiny_box = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(1), Inches(1), Inches(1.5), Inches(0.4))
        tiny_box.text = "This is a deliberately very long text string that will overflow a tiny 1.5x0.4 inch slide shape box easily."
        prs.save(self.source)
        pptx_report = json.loads(self.run_worker("pptx", "verify"))
        pptx_checks = {c["id"]: c["status"] for c in pptx_report["checks"]}
        self.assertEqual(pptx_checks["text_overflow"], "failed")
        self.assertEqual(pptx_checks["layer_visual_consistency"], "passed")

        # 2. DOCX layout quality check (clean document passes layout_quality)
        doc = Document()
        doc.add_heading("Layout Verification", level=1)
        doc.add_paragraph("Body text comfortably within page margins.")
        doc.save(self.source)
        docx_report = json.loads(self.run_worker("docx", "verify"))
        docx_checks = {c["id"]: c["status"] for c in docx_report["checks"]}
        self.assertEqual(docx_checks["layout_quality"], "passed")

        # 3. XLSX text truncation detection (long text next to occupied neighbor + narrow column)
        wb = Workbook()
        ws = wb.active
        ws.column_dimensions["A"].width = 6
        ws["A1"] = "VeryLongUnwrappedHeaderTextThatGetsClipped"
        ws["B1"] = "Blocker"
        wb.save(self.source)
        xlsx_report = json.loads(self.run_worker("xlsx", "verify"))
        xlsx_checks = {c["id"]: c["status"] for c in xlsx_report["checks"]}
        self.assertEqual(xlsx_checks["text_truncation"], "failed")
        self.assertIn("xlsx_text_truncation", [i["code"] for i in xlsx_report["issues"]])

    def _build_linear_smartart_pptx(self, lo_type_id, axis, items, with_arrows):
        import uuid
        DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
        DSP = "http://schemas.microsoft.com/office/drawing/2008/diagram"
        A = "http://schemas.openxmlformats.org/drawingml/2006/main"
        P = "http://schemas.openxmlformats.org/presentationml/2006/main"
        R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        REL = "http://schemas.openxmlformats.org/package/2006/relationships"
        CT = "http://schemas.openxmlformats.org/package/2006/content-types"

        prs = Presentation()
        prs.slides.add_slide(prs.slide_layouts[6])
        buf = io.BytesIO()
        prs.save(buf)
        buf.seek(0)
        frame_x, frame_y, frame_cx, frame_cy = 914400, 914400, 7315200, 4572000
        doc_id = "{" + str(uuid.uuid4()).upper() + "}"
        pres_root_id = "{" + str(uuid.uuid4()).upper() + "}"

        data_root = XML.Element(f"{{{DGM}}}dataModel", nsmap={"dgm": DGM, "a": A, "r": R})
        pt_lst = XML.SubElement(data_root, f"{{{DGM}}}ptLst")
        cxn_lst = XML.SubElement(data_root, f"{{{DGM}}}cxnLst")
        XML.SubElement(data_root, f"{{{DGM}}}bg")
        XML.SubElement(data_root, f"{{{DGM}}}whole")
        ext_lst = XML.SubElement(data_root, f"{{{DGM}}}extLst")
        ext = XML.SubElement(ext_lst, f"{{{A}}}ext", uri=DSP)
        XML.SubElement(ext, f"{{{DSP}}}dataModelExt", relId="rId5", minVer=A)

        doc_pt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=doc_id, type="doc")
        XML.SubElement(doc_pt, f"{{{DGM}}}prSet", loTypeId=lo_type_id)
        XML.SubElement(doc_pt, f"{{{DGM}}}spPr")
        pr_pt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=pres_root_id, type="pres")
        XML.SubElement(pr_pt, f"{{{DGM}}}prSet", presAssocID=doc_id, presName="root", loTypeId=lo_type_id)
        XML.SubElement(pr_pt, f"{{{DGM}}}spPr")
        XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                       type="presOf", srcId=doc_id, destId=pres_root_id, srcOrd="0", destOrd="0", presId=lo_type_id)

        draw_root = XML.Element(f"{{{DSP}}}drawing", nsmap={"dgm": DGM, "dsp": DSP, "a": A})
        sp_tree = XML.SubElement(draw_root, f"{{{DSP}}}spTree")
        nv_grp = XML.SubElement(sp_tree, f"{{{DSP}}}nvGrpSpPr")
        XML.SubElement(nv_grp, f"{{{DSP}}}cNvPr", id="0", name="")
        XML.SubElement(nv_grp, f"{{{DSP}}}cNvGrpSpPr")
        XML.SubElement(sp_tree, f"{{{DSP}}}grpSpPr")

        n = len(items)
        gap = 160000
        arrow_w = 280000 if with_arrows else 0
        box_w = (frame_cx - (gap + arrow_w) * (n - 1)) // n if axis == "horizontal" else frame_cx
        box_h = frame_cy if axis == "horizontal" else (frame_cy - (gap + arrow_w) * (n - 1)) // n
        pres_ord = 0
        for idx, label in enumerate(items):
            nid = "{" + str(uuid.uuid4()).upper() + "}"
            ptid = "{" + str(uuid.uuid4()).upper() + "}"
            stid = "{" + str(uuid.uuid4()).upper() + "}"
            pid = "{" + str(uuid.uuid4()).upper() + "}"
            npt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=nid)
            XML.SubElement(npt, f"{{{DGM}}}prSet")
            XML.SubElement(npt, f"{{{DGM}}}spPr")
            dt = XML.SubElement(npt, f"{{{DGM}}}t")
            XML.SubElement(dt, f"{{{A}}}bodyPr")
            XML.SubElement(dt, f"{{{A}}}lstStyle")
            XML.SubElement(XML.SubElement(XML.SubElement(dt, f"{{{A}}}p"), f"{{{A}}}r"), f"{{{A}}}t").text = label
            XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=ptid, type="parTrans")
            XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=stid, type="sibTrans")
            ppt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=pid, type="pres")
            XML.SubElement(ppt, f"{{{DGM}}}prSet", presAssocID=nid, presName="node", loTypeId=lo_type_id)
            XML.SubElement(ppt, f"{{{DGM}}}spPr")
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           srcId=doc_id, destId=nid, srcOrd=str(idx), destOrd="0", parTransId=ptid, sibTransId=stid)
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           type="presOf", srcId=nid, destId=pid, srcOrd="0", destOrd="0", presId=lo_type_id)
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           type="presParOf", srcId=pres_root_id, destId=pid, srcOrd=str(pres_ord), destOrd="0", presId=lo_type_id)
            pres_ord += 1
            x = idx * (box_w + gap + arrow_w) if axis == "horizontal" else 0
            y = 0 if axis == "horizontal" else idx * (box_h + gap + arrow_w)
            sp = XML.SubElement(sp_tree, f"{{{DSP}}}sp", modelId=pid)
            nv = XML.SubElement(sp, f"{{{DSP}}}nvSpPr")
            XML.SubElement(nv, f"{{{DSP}}}cNvPr", id=str(10 + pres_ord), name=f"Node {idx + 1}")
            XML.SubElement(nv, f"{{{DSP}}}cNvSpPr")
            sp_pr = XML.SubElement(sp, f"{{{DSP}}}spPr")
            xf = XML.SubElement(sp_pr, f"{{{A}}}xfrm")
            XML.SubElement(xf, f"{{{A}}}off", x=str(x), y=str(y))
            XML.SubElement(xf, f"{{{A}}}ext", cx=str(box_w), cy=str(box_h))
            XML.SubElement(XML.SubElement(sp_pr, f"{{{A}}}prstGeom", prst="roundRect"), f"{{{A}}}avLst")
            XML.SubElement(XML.SubElement(sp_pr, f"{{{A}}}solidFill"), f"{{{A}}}srgbClr", val="4F81BD")
            tx = XML.SubElement(sp, f"{{{DSP}}}txBody")
            XML.SubElement(tx, f"{{{A}}}bodyPr", wrap="square", anchor="ctr")
            XML.SubElement(tx, f"{{{A}}}lstStyle")
            r_el = XML.SubElement(XML.SubElement(tx, f"{{{A}}}p"), f"{{{A}}}r")
            XML.SubElement(r_el, f"{{{A}}}rPr", lang="en-US", sz="1400")
            XML.SubElement(r_el, f"{{{A}}}t").text = label
            if with_arrows and idx < n - 1:
                apid = "{" + str(uuid.uuid4()).upper() + "}"
                apt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=apid, type="pres")
                XML.SubElement(apt, f"{{{DGM}}}prSet", presAssocID=stid, presName="sibTrans", loTypeId=lo_type_id)
                XML.SubElement(apt, f"{{{DGM}}}spPr")
                XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                               type="presOf", srcId=stid, destId=apid, srcOrd="0", destOrd="0", presId=lo_type_id)
                XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                               type="presParOf", srcId=pres_root_id, destId=apid, srcOrd=str(pres_ord), destOrd="0", presId=lo_type_id)
                pres_ord += 1
                asp = XML.SubElement(sp_tree, f"{{{DSP}}}sp", modelId=apid)
                anv = XML.SubElement(asp, f"{{{DSP}}}nvSpPr")
                XML.SubElement(anv, f"{{{DSP}}}cNvPr", id=str(10 + pres_ord), name=f"Arrow {idx + 1}")
                XML.SubElement(anv, f"{{{DSP}}}cNvSpPr")
                apr = XML.SubElement(asp, f"{{{DSP}}}spPr")
                axf = XML.SubElement(apr, f"{{{A}}}xfrm")
                XML.SubElement(axf, f"{{{A}}}off", x=str(x + box_w + gap // 2), y=str(box_h // 2 - 120000))
                XML.SubElement(axf, f"{{{A}}}ext", cx=str(arrow_w), cy="240000")
                XML.SubElement(XML.SubElement(apr, f"{{{A}}}prstGeom", prst="rightArrow"), f"{{{A}}}avLst")
                XML.SubElement(XML.SubElement(apr, f"{{{A}}}solidFill"), f"{{{A}}}srgbClr", val="808080")

        out = io.BytesIO()
        with zipfile.ZipFile(buf) as zin, zipfile.ZipFile(out, "w") as zout:
            slide = XML.fromstring(zin.read("ppt/slides/slide1.xml"))
            tree = slide.find(f".//{{{P}}}spTree")
            gf = XML.SubElement(tree, f"{{{P}}}graphicFrame")
            nvgf = XML.SubElement(gf, f"{{{P}}}nvGraphicFramePr")
            XML.SubElement(nvgf, f"{{{P}}}cNvPr", id="2", name="SmartArt1")
            XML.SubElement(nvgf, f"{{{P}}}cNvGraphicFramePr")
            XML.SubElement(nvgf, f"{{{P}}}nvPr")
            gxf = XML.SubElement(gf, f"{{{P}}}xfrm")
            XML.SubElement(gxf, f"{{{A}}}off", x=str(frame_x), y=str(frame_y))
            XML.SubElement(gxf, f"{{{A}}}ext", cx=str(frame_cx), cy=str(frame_cy))
            gdata = XML.SubElement(XML.SubElement(gf, f"{{{A}}}graphic"), f"{{{A}}}graphicData", uri=DGM)
            rids = XML.SubElement(gdata, f"{{{DGM}}}relIds")
            rids.set(f"{{{R}}}dm", "rId2")
            rids.set(f"{{{R}}}lo", "rId3")
            rids.set(f"{{{R}}}qs", "rId4")
            rids.set(f"{{{R}}}cs", "rId6")
            srels = XML.fromstring(zin.read("ppt/slides/_rels/slide1.xml.rels"))
            for rid, rtype, tgt in (
                ("rId2", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData", "../diagrams/data1.xml"),
                ("rId3", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout", "../diagrams/layout1.xml"),
                ("rId4", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle", "../diagrams/quickStyle1.xml"),
                ("rId5", "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing", "../diagrams/drawing1.xml"),
                ("rId6", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors", "../diagrams/colors1.xml"),
            ):
                XML.SubElement(srels, f"{{{REL}}}Relationship", Id=rid, Type=rtype, Target=tgt)
            ct = XML.fromstring(zin.read("[Content_Types].xml"))
            for part, ctype in (
                ("/ppt/diagrams/data1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"),
                ("/ppt/diagrams/layout1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml"),
                ("/ppt/diagrams/quickStyle1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml"),
                ("/ppt/diagrams/colors1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml"),
                ("/ppt/diagrams/drawing1.xml", "application/vnd.ms-office.drawingml.diagramDrawing+xml"),
            ):
                XML.SubElement(ct, f"{{{CT}}}Override", PartName=part, ContentType=ctype)
            repls = {
                "ppt/slides/slide1.xml": XML.tostring(slide),
                "ppt/slides/_rels/slide1.xml.rels": XML.tostring(srels),
                "[Content_Types].xml": XML.tostring(ct),
            }
            for info in zin.infolist():
                zout.writestr(info, repls.get(info.filename, zin.read(info.filename)))
            zout.writestr("ppt/diagrams/data1.xml", XML.tostring(data_root))
            zout.writestr("ppt/diagrams/drawing1.xml", XML.tostring(draw_root))
            zout.writestr("ppt/diagrams/layout1.xml", b'<dgm:layoutDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>')
            zout.writestr("ppt/diagrams/quickStyle1.xml", b'<dgm:styleDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>')
            zout.writestr("ppt/diagrams/colors1.xml", b'<dgm:colorsDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>')
        return out.getvalue()

    def _build_computable_smartart_pptx(self, kind, texts, ch_max=None):
        """Build a spec-compliant OOXML SmartArt PPTX with real dgm:layoutDef for LibreOffice layout evaluation."""
        import uuid
        A = "http://schemas.openxmlformats.org/drawingml/2006/main"
        DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram"
        DSP = "http://schemas.microsoft.com/office/drawing/2008/diagram"
        P = "http://schemas.openxmlformats.org/presentationml/2006/main"
        R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        REL = "http://schemas.openxmlformats.org/package/2006/relationships"
        CT = "http://schemas.openxmlformats.org/package/2006/content-types"

        prs = Presentation()
        prs.slide_width = Inches(10)
        prs.slide_height = Inches(7.5)
        prs.slides.add_slide(prs.slide_layouts[6])
        buf = io.BytesIO()
        prs.save(buf)

        if kind == "cycle4":
            lo_type_id = "urn:microsoft.com/office/officeart/2005/8/layout/cycle4"
            node_pres_name = "node"
            layout_xml = f'''<dgm:layoutDef xmlns:dgm="{DGM}" xmlns:a="{A}" uniqueId="{lo_type_id}">
              <dgm:layoutNode name="diagram">
                <dgm:alg type="composite"/>
                <dgm:layoutNode name="cycle">
                  <dgm:alg type="cycle"/>
                  <dgm:forEach name="fe1" axis="ch" ptType="node">
                    <dgm:layoutNode name="node">
                      <dgm:alg type="tx"/>
                      <dgm:shape type="ellipse"/>
                      <dgm:presOf axis="desOrSelf" ptType="node"/>
                    </dgm:layoutNode>
                  </dgm:forEach>
                </dgm:layoutNode>
              </dgm:layoutNode>
            </dgm:layoutDef>'''.encode("utf-8")
        elif kind == "pyramid1":
            lo_type_id = "urn:microsoft.com/office/officeart/2005/8/layout/pyramid1"
            node_pres_name = "node"
            layout_xml = f'''<dgm:layoutDef xmlns:dgm="{DGM}" xmlns:a="{A}" uniqueId="{lo_type_id}">
              <dgm:layoutNode name="diagram">
                <dgm:alg type="pyra"/>
                <dgm:forEach name="fe1" axis="ch" ptType="node">
                  <dgm:layoutNode name="node">
                    <dgm:alg type="tx"/>
                    <dgm:shape type="trapezoid"/>
                    <dgm:presOf axis="desOrSelf" ptType="node"/>
                  </dgm:layoutNode>
                </dgm:forEach>
              </dgm:layoutNode>
            </dgm:layoutDef>'''.encode("utf-8")
        elif kind == "matrix_snake":
            lo_type_id = "urn:microsoft.com/office/officeart/2005/8/layout/matrix1"
            node_pres_name = "node"
            layout_xml = f'''<dgm:layoutDef xmlns:dgm="{DGM}" xmlns:a="{A}" uniqueId="{lo_type_id}">
              <dgm:layoutNode name="diagram">
                <dgm:alg type="snake"/>
                <dgm:forEach name="fe1" axis="ch" ptType="node">
                  <dgm:layoutNode name="node">
                    <dgm:alg type="tx"/>
                    <dgm:shape type="roundRect"/>
                    <dgm:presOf axis="desOrSelf" ptType="node"/>
                  </dgm:layoutNode>
                </dgm:forEach>
              </dgm:layoutNode>
            </dgm:layoutDef>'''.encode("utf-8")
        elif kind == "hierarchy1":
            lo_type_id = "urn:microsoft.com/office/officeart/2005/8/layout/hierarchy1"
            node_pres_name = "childNode"
            layout_xml = f'''<dgm:layoutDef xmlns:dgm="{DGM}" xmlns:a="{A}" uniqueId="{lo_type_id}">
              <dgm:layoutNode name="diagram">
                <dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg>
                <dgm:forEach name="feRoot" axis="ch" ptType="node">
                  <dgm:layoutNode name="branch">
                    <dgm:alg type="lin"><dgm:param type="linDir" val="fromT"/></dgm:alg>
                    <dgm:layoutNode name="rootNode">
                      <dgm:alg type="tx"/><dgm:shape type="rect"/>
                      <dgm:presOf axis="self" ptType="node"/>
                    </dgm:layoutNode>
                    <dgm:layoutNode name="childrenRow">
                      <dgm:alg type="lin"><dgm:param type="linDir" val="fromL"/></dgm:alg>
                      <dgm:forEach name="feCh" axis="ch" ptType="node">
                        <dgm:layoutNode name="childNode">
                          <dgm:alg type="tx"/><dgm:shape type="roundRect"/>
                          <dgm:presOf axis="self" ptType="node"/>
                        </dgm:layoutNode>
                      </dgm:forEach>
                    </dgm:layoutNode>
                  </dgm:layoutNode>
                </dgm:forEach>
              </dgm:layoutNode>
            </dgm:layoutDef>'''.encode("utf-8")
        elif kind == "venn_stub":
            lo_type_id = "urn:microsoft.com/office/officeart/2005/8/layout/venn1"
            node_pres_name = "node"
            layout_xml = f'<dgm:layoutDef xmlns:dgm="{DGM}" uniqueId="{lo_type_id}"/>'.encode("utf-8")
        else:
            raise ValueError(f"Unknown SmartArt fixture kind: {kind}")

        if ch_max is not None and kind != "venn_stub":
            lo_root = XML.fromstring(layout_xml)
            var_lst = XML.SubElement(lo_root.find(f"{{{DGM}}}layoutNode"), f"{{{DGM}}}varLst")
            XML.SubElement(var_lst, f"{{{DGM}}}chMax", val=str(ch_max))
            layout_xml = XML.tostring(lo_root)

        doc_id = "{00000000-0000-0000-0000-000000000001}"
        pres_root_id = "{00000000-0000-0000-0000-000000000002}"
        data_root = XML.Element(f"{{{DGM}}}dataModel", nsmap={"dgm": DGM, "a": A, "r": R})
        pt_lst = XML.SubElement(data_root, f"{{{DGM}}}ptLst")
        cxn_lst = XML.SubElement(data_root, f"{{{DGM}}}cxnLst")
        XML.SubElement(data_root, f"{{{DGM}}}bg")
        XML.SubElement(data_root, f"{{{DGM}}}whole")
        ext_lst = XML.SubElement(data_root, f"{{{DGM}}}extLst")
        ext = XML.SubElement(ext_lst, f"{{{A}}}ext", uri="http://schemas.microsoft.com/office/drawing/2008/diagram")
        XML.SubElement(ext, f"{{{DSP}}}dataModelExt", relId="rId5", minVer="http://schemas.openxmlformats.org/drawingml/2006/main")

        doc_pt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=doc_id, type="doc")
        XML.SubElement(doc_pt, f"{{{DGM}}}prSet", loTypeId=lo_type_id)
        XML.SubElement(doc_pt, f"{{{DGM}}}spPr")
        pr_pt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=pres_root_id, type="pres")
        XML.SubElement(pr_pt, f"{{{DGM}}}prSet", presAssocID=doc_id, presName="diagram", loTypeId=lo_type_id)
        XML.SubElement(pr_pt, f"{{{DGM}}}spPr")
        XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                       type="presOf", srcId=doc_id, destId=pres_root_id, srcOrd="0", destOrd="0", presId=lo_type_id)

        draw_root = XML.Element(f"{{{DSP}}}drawing", nsmap={"dsp": DSP, "a": A, "r": R})
        sp_tree = XML.SubElement(draw_root, f"{{{DSP}}}spTree")
        nvg = XML.SubElement(sp_tree, f"{{{DSP}}}nvGrpSpPr")
        XML.SubElement(nvg, f"{{{DSP}}}cNvPr", id="0", name="")
        XML.SubElement(nvg, f"{{{DSP}}}cNvGrpSpPr")
        XML.SubElement(sp_tree, f"{{{DSP}}}grpSpPr")

        def add_node_pt(nid, text, parent_id, ord_idx, pres_parent_id, pres_ord_idx, pres_name, idx_style, cnt_style):
            npt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=nid)
            XML.SubElement(npt, f"{{{DGM}}}prSet")
            XML.SubElement(npt, f"{{{DGM}}}spPr")
            t_el = XML.SubElement(npt, f"{{{DGM}}}t")
            XML.SubElement(t_el, f"{{{A}}}bodyPr")
            XML.SubElement(t_el, f"{{{A}}}lstStyle")
            p_el = XML.SubElement(t_el, f"{{{A}}}p")
            r_el = XML.SubElement(p_el, f"{{{A}}}r")
            XML.SubElement(r_el, f"{{{A}}}t").text = text
            stid = "{" + str(uuid.uuid4()).upper() + "}"
            ptid = "{" + str(uuid.uuid4()).upper() + "}"
            XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=stid, type="sibTrans", cxnId=nid)
            XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=ptid, type="parTrans", cxnId=nid)
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           srcId=parent_id, destId=nid, srcOrd=str(ord_idx), destOrd="0",
                           parTransId=ptid, sibTransId=stid)
            pid = "{" + str(uuid.uuid4()).upper() + "}"
            ppt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=pid, type="pres")
            XML.SubElement(ppt, f"{{{DGM}}}prSet", presAssocID=nid, presName=pres_name,
                           presStyleLbl="node0", presStyleIdx=str(idx_style), presStyleCnt=str(cnt_style),
                           loTypeId=lo_type_id)
            XML.SubElement(ppt, f"{{{DGM}}}spPr")
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           type="presOf", srcId=nid, destId=pid, srcOrd="0", destOrd="0", presId=lo_type_id)
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           type="presParOf", srcId=pres_parent_id, destId=pid, srcOrd=str(pres_ord_idx), destOrd="0", presId=lo_type_id)
            return pid

        if kind == "hierarchy1":
            # texts = (root_text, [child1, child2, ...])
            root_text, child_texts = texts
            root_nid = "{10000000-0000-0000-0000-000000000001}"
            branch_pid = "{" + str(uuid.uuid4()).upper() + "}"
            bpt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=branch_pid, type="pres")
            XML.SubElement(bpt, f"{{{DGM}}}prSet", presAssocID=root_nid, presName="branch", loTypeId=lo_type_id)
            XML.SubElement(bpt, f"{{{DGM}}}spPr")
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           type="presParOf", srcId=pres_root_id, destId=branch_pid, srcOrd="0", destOrd="0", presId=lo_type_id)
            add_node_pt(root_nid, root_text, doc_id, 0, branch_pid, 0, "rootNode", 0, 1)
            row_pid = "{" + str(uuid.uuid4()).upper() + "}"
            rpt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=row_pid, type="pres")
            XML.SubElement(rpt, f"{{{DGM}}}prSet", presAssocID=root_nid, presName="childrenRow", loTypeId=lo_type_id)
            XML.SubElement(rpt, f"{{{DGM}}}spPr")
            XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                           type="presParOf", srcId=branch_pid, destId=row_pid, srcOrd="1", destOrd="0", presId=lo_type_id)
            for idx, txt in enumerate(child_texts):
                cid = f"{{20000000-0000-0000-0000-00000000000{idx + 1}}}"
                add_node_pt(cid, txt, root_nid, idx, row_pid, idx, node_pres_name, idx, len(child_texts))
        else:
            container_pid = pres_root_id
            if kind == "cycle4":
                container_pid = "{" + str(uuid.uuid4()).upper() + "}"
                cpt = XML.SubElement(pt_lst, f"{{{DGM}}}pt", modelId=container_pid, type="pres")
                XML.SubElement(cpt, f"{{{DGM}}}prSet", presAssocID=doc_id, presName="cycle", loTypeId=lo_type_id)
                XML.SubElement(cpt, f"{{{DGM}}}spPr")
                XML.SubElement(cxn_lst, f"{{{DGM}}}cxn", modelId="{" + str(uuid.uuid4()).upper() + "}",
                               type="presParOf", srcId=pres_root_id, destId=container_pid, srcOrd="0", destOrd="0", presId=lo_type_id)
            for idx, txt in enumerate(texts):
                nid = f"{{10000000-0000-0000-0000-00000000000{idx + 1}}}"
                add_node_pt(nid, txt, doc_id, idx, container_pid, idx, node_pres_name, idx, len(texts))

        out = io.BytesIO()
        with zipfile.ZipFile(buf) as zin, zipfile.ZipFile(out, "w") as zout:
            slide = XML.fromstring(zin.read("ppt/slides/slide1.xml"))
            tree = slide.find(f".//{{{P}}}spTree")
            gf = XML.SubElement(tree, f"{{{P}}}graphicFrame")
            nvgf = XML.SubElement(gf, f"{{{P}}}nvGraphicFramePr")
            XML.SubElement(nvgf, f"{{{P}}}cNvPr", id="2", name="SmartArt1")
            XML.SubElement(nvgf, f"{{{P}}}cNvGraphicFramePr")
            XML.SubElement(nvgf, f"{{{P}}}nvPr")
            gxf = XML.SubElement(gf, f"{{{P}}}xfrm")
            XML.SubElement(gxf, f"{{{A}}}off", x="457200", y="457200")
            XML.SubElement(gxf, f"{{{A}}}ext", cx="8229600", cy="5943600")
            gdata = XML.SubElement(XML.SubElement(gf, f"{{{A}}}graphic"), f"{{{A}}}graphicData", uri=DGM)
            rids = XML.SubElement(gdata, f"{{{DGM}}}relIds")
            rids.set(f"{{{R}}}dm", "rId2")
            rids.set(f"{{{R}}}lo", "rId3")
            rids.set(f"{{{R}}}qs", "rId4")
            rids.set(f"{{{R}}}cs", "rId6")
            srels = XML.fromstring(zin.read("ppt/slides/_rels/slide1.xml.rels"))
            for rid, rtype, tgt in (
                ("rId2", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData", "../diagrams/data1.xml"),
                ("rId3", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramLayout", "../diagrams/layout1.xml"),
                ("rId4", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramQuickStyle", "../diagrams/quickStyle1.xml"),
                ("rId5", "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing", "../diagrams/drawing1.xml"),
                ("rId6", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramColors", "../diagrams/colors1.xml"),
            ):
                XML.SubElement(srels, f"{{{REL}}}Relationship", Id=rid, Type=rtype, Target=tgt)
            ct = XML.fromstring(zin.read("[Content_Types].xml"))
            for part, ctype in (
                ("/ppt/diagrams/data1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml"),
                ("/ppt/diagrams/layout1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml"),
                ("/ppt/diagrams/quickStyle1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml"),
                ("/ppt/diagrams/colors1.xml", "application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml"),
                ("/ppt/diagrams/drawing1.xml", "application/vnd.ms-office.drawingml.diagramDrawing+xml"),
            ):
                XML.SubElement(ct, f"{{{CT}}}Override", PartName=part, ContentType=ctype)
            repls = {
                "ppt/slides/slide1.xml": XML.tostring(slide),
                "ppt/slides/_rels/slide1.xml.rels": XML.tostring(srels),
                "[Content_Types].xml": XML.tostring(ct),
            }
            for info in zin.infolist():
                zout.writestr(info, repls.get(info.filename, zin.read(info.filename)))
            zout.writestr("ppt/diagrams/data1.xml", XML.tostring(data_root))
            zout.writestr("ppt/diagrams/drawing1.xml", XML.tostring(draw_root))
            zout.writestr("ppt/diagrams/layout1.xml", layout_xml)
            zout.writestr("ppt/diagrams/quickStyle1.xml", b'<dgm:styleDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>')
            zout.writestr("ppt/diagrams/colors1.xml", b'<dgm:colorsDef xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>')
        return out.getvalue()

    def test_smartart_add_or_remove_node_supported_families_and_limits(self):
        # 1. Linear process (process1 with stub layoutDef): linear fallback still works
        proc_pptx = self._build_linear_smartart_pptx(
            "urn:microsoft.com/office/officeart/2005/8/layout/process1", "horizontal", ["Step1", "Step2", "Step3"], True
        )
        self.source.write_bytes(proc_pptx)
        info = json.loads(self.run_worker("pptx", "range", range={"part": "ppt/diagrams/data1.xml"}))
        self.assertTrue(info["supportsNodeAddRemove"])
        self.assertEqual(info["layoutFamily"], "linear_process")
        self.assertEqual(info["layoutEngine"], "linear_reflow")

        added = self.run_worker("pptx", "edit", operations=[
            {"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
             "dataPart": "ppt/diagrams/data1.xml", "mode": "add", "text": "Step4"},
        ])
        self.source.write_bytes(added)
        pdf_added = self.run_worker("pptx", "export", targetFormat="pdf")
        txt_added = PdfReader(io.BytesIO(pdf_added)).pages[0].extract_text() or ""
        for step in ("Step1", "Step2", "Step3", "Step4"):
            self.assertIn(step, txt_added)

        removed = self.run_worker("pptx", "edit", operations=[
            {"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
             "dataPart": "ppt/diagrams/data1.xml", "mode": "remove", "index": 1},
        ])
        self.source.write_bytes(removed)
        pdf_removed = self.run_worker("pptx", "export", targetFormat="pdf")
        txt_removed = PdfReader(io.BytesIO(pdf_removed)).pages[0].extract_text() or ""
        self.assertIn("Step1", txt_removed)
        self.assertNotIn("Step2", txt_removed)
        self.assertIn("Step4", txt_removed)

        # 2. Computable OOXML diagrams via LibreOffice DIAGRAM_IGNORE_EXTDRAWINGS=1:
        #    Cycle, Pyramid, Matrix/Snake, and Hierarchy (with parentNodeId)
        for kind, init_texts, add_op_extra, add_text, edit_text, remove_idx in (
            ("cycle4", ["Plan", "Build", "Test"], {}, "Deploy", "Deploy2", 1),
            ("pyramid1", ["Top", "Mid", "Base"], {}, "Foot", "Foot2", 1),
            ("matrix_snake", ["Q1", "Q2", "Q3"], {}, "Q4", "Q4New", 0),
            ("hierarchy1", ("CEO", ["VP1", "VP2"]), {"parentNodeId": "{10000000-0000-0000-0000-000000000001}"}, "VP3", "VP3X", 1),
        ):
            with self.subTest(smartart_kind=kind):
                pptx_bytes = self._build_computable_smartart_pptx(kind, init_texts)
                self.source.write_bytes(pptx_bytes)
                meta = json.loads(self.run_worker("pptx", "range", range={"part": "ppt/diagrams/data1.xml"}))
                self.assertTrue(meta["supportsNodeAddRemove"], msg=meta)
                self.assertEqual(meta["layoutEngine"], "libreoffice_layout_def")

                # Add node
                out_added = self.run_worker("pptx", "edit", operations=[
                    {"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
                     "dataPart": "ppt/diagrams/data1.xml", "mode": "add", "text": add_text, **add_op_extra},
                ])
                self.source.write_bytes(out_added)
                after_add = json.loads(self.run_worker("pptx", "range", range={"part": "ppt/diagrams/data1.xml"}))
                content_nodes = [n for n in after_add["nodes"] if n["type"] is None]
                added_node = next((n for n in content_nodes if n["text"] == add_text), None)
                self.assertIsNotNone(added_node, msg=f"{kind}: added node missing in dataModel")

                # Re-edit added node via smartart.update_node_text (proves editable SmartArt structure persists)
                out_edited = self.run_worker("pptx", "edit", operations=[
                    {"op": "pptx.smartart.update_node_text", "slidePart": "ppt/slides/slide1.xml",
                     "dataPart": "ppt/diagrams/data1.xml", "nodeId": added_node["id"], "text": edit_text},
                ])
                self.source.write_bytes(out_edited)
                pdf_edited = self.run_worker("pptx", "export", targetFormat="pdf")
                txt_edited = PdfReader(io.BytesIO(pdf_edited)).pages[0].extract_text() or ""
                self.assertIn(edit_text, txt_edited)

                # Remove a node
                out_removed = self.run_worker("pptx", "edit", operations=[
                    {"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
                     "dataPart": "ppt/diagrams/data1.xml", "mode": "remove", "index": remove_idx, **add_op_extra},
                ])
                self.source.write_bytes(out_removed)
                verify_res = json.loads(self.run_worker("pptx", "verify"))
                for check_id in ("package_structure", "archive_security", "relationship_ids"):
                    chk = next(c for c in verify_res["checks"] if c["id"] == check_id)
                    self.assertEqual(chk["status"], "passed", msg=f"{kind}: {chk}")
                pdf_rem = self.run_worker("pptx", "export", targetFormat="pdf")
                txt_rem = PdfReader(io.BytesIO(pdf_rem)).pages[0].extract_text() or ""
                self.assertIn(edit_text, txt_rem)

        # 3. Non-linear diagram with empty/stub layoutDef (uncomputable): must reject with exit code 4
        stub_venn = self._build_computable_smartart_pptx("venn_stub", ["A", "B", "C"])
        self.source.write_bytes(stub_venn)
        stub_info = json.loads(self.run_worker("pptx", "range", range={"part": "ppt/diagrams/data1.xml"}))
        self.assertFalse(stub_info["supportsNodeAddRemove"])
        (self.inputs / "request.json").write_text(json.dumps({
            "format": "pptx", "filename": "venn_stub.pptx", "action": "edit",
            "operations": [{"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
                            "dataPart": "ppt/diagrams/data1.xml", "mode": "add", "text": "D"}],
        }), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(WORKER)],
            env=dict(os.environ, AGY_WORKER_IN_DIR=str(self.inputs), AGY_WORKER_OUT_DIR=str(self.outputs)),
            cwd=self.directory, capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 4)

        # 4. Real PowerPoint Venn fixture (smartart-simple.pptx -> venn1, chMax=7):
        #    Must SUPPORT add -> update_node_text -> remove -> verify -> render, and REJECT 8th node (> chMax) with exit 4
        fixture = os.environ.get("AGY_TEST_SMARTART_FILE")
        if fixture and Path(fixture).is_file():
            self.source.write_bytes(Path(fixture).read_bytes())
            venn_info = json.loads(self.run_worker("pptx", "range", range={"part": "ppt/diagrams/data1.xml"}))
            self.assertTrue(venn_info["supportsNodeAddRemove"])
            self.assertEqual(venn_info["layoutFamily"], "venn1")
            self.assertEqual(venn_info["layoutEngine"], "libreoffice_layout_def")
            self.assertEqual(venn_info["chMax"], 7)

            # Add 5th circle ("Omega")
            v_added = self.run_worker("pptx", "edit", operations=[
                {"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
                 "dataPart": "ppt/diagrams/data1.xml", "mode": "add", "text": "Omega"},
            ])
            self.source.write_bytes(v_added)
            v_after = json.loads(self.run_worker("pptx", "range", range={"part": "ppt/diagrams/data1.xml"}))
            v_nodes = [n for n in v_after["nodes"] if n["type"] is None]
            self.assertEqual(len(v_nodes), 5)
            omega_node = next(n for n in v_nodes if n["text"] == "Omega")

            # Re-edit added node via smartart.update_node_text
            v_edited = self.run_worker("pptx", "edit", operations=[
                {"op": "pptx.smartart.update_node_text", "slidePart": "ppt/slides/slide1.xml",
                 "dataPart": "ppt/diagrams/data1.xml", "nodeId": omega_node["id"], "text": "Zeta"},
            ])
            self.source.write_bytes(v_edited)

            # Remove "def" (index 1)
            v_removed = self.run_worker("pptx", "edit", operations=[
                {"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
                 "dataPart": "ppt/diagrams/data1.xml", "mode": "remove", "index": 1},
            ])
            self.source.write_bytes(v_removed)
            v_verify = json.loads(self.run_worker("pptx", "verify"))
            for check_id in ("package_structure", "archive_security", "relationship_ids", "layer_visual_consistency"):
                chk = next(c for c in v_verify["checks"] if c["id"] == check_id)
                self.assertEqual(chk["status"], "passed", msg=f"real venn1: {chk}")
            v_pdf = self.run_worker("pptx", "export", targetFormat="pdf")
            v_txt = PdfReader(io.BytesIO(v_pdf)).pages[0].extract_text() or ""
            v_compact = "".join(v_txt.split())
            self.assertNotIn("def", v_compact)
            self.assertIn("Zeta", v_compact)

            # Exceeding layoutDef chMax=7 (4 -> 5 -> 6 -> 7 ok, 8th node -> exit code 4)
            cur = v_removed
            for i in range(3):
                self.source.write_bytes(cur)
                cur = self.run_worker("pptx", "edit", operations=[
                    {"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
                     "dataPart": "ppt/diagrams/data1.xml", "mode": "add", "text": f"N{i}"},
                ])
            self.source.write_bytes(cur)
            (self.inputs / "request.json").write_text(json.dumps({
                "format": "pptx", "filename": "venn_max.pptx", "action": "edit",
                "operations": [{"op": "pptx.smartart.add_or_remove_node", "slidePart": "ppt/slides/slide1.xml",
                                "dataPart": "ppt/diagrams/data1.xml", "mode": "add", "text": "Overflow8"}],
            }), encoding="utf-8")
            proc_max = subprocess.run(
                [sys.executable, str(WORKER)],
                env=dict(os.environ, AGY_WORKER_IN_DIR=str(self.inputs), AGY_WORKER_OUT_DIR=str(self.outputs)),
                cwd=self.directory, capture_output=True, text=True,
            )
            self.assertEqual(proc_max.returncode, 4)

    def test_pptx_visual_consistency_arbitrary_slides_and_resource_budgets(self):
        prs = Presentation()
        prs.slide_width = Inches(10)
        prs.slide_height = Inches(5.625)
        for s_idx in range(4):
            slide = prs.slides.add_slide(prs.slide_layouts[6])
            shape_count = 10 if s_idx == 2 else 2
            for k in range(shape_count):
                col = k % 5
                row = k // 5
                tb = slide.shapes.add_textbox(Inches(0.5 + col * 1.8), Inches(0.5 + row * 1.6), Inches(1.5), Inches(1.0))
                tb.text_frame.text = f"S{s_idx + 1}-Box{k + 1}"
        buf = io.BytesIO()
        prs.save(buf)
        self.source.write_bytes(buf.getvalue())

        # 1. Targeted verification of slide index 2 (3rd slide, 10 shapes — previously impossible under slides[:2] & <=8)
        targeted = json.loads(self.run_worker("pptx", "verify", options={"slideIndices": [2], "maxShapesPerSlide": 12}))
        lvc_check = next(c for c in targeted["checks"] if c["id"] == "layer_visual_consistency")
        # Partial slide selection MUST NOT report whole-document passed
        self.assertEqual(lvc_check["status"], "unverified")
        self.assertEqual(targeted["coverage"], "partial")
        lvc = targeted["metrics"]["layerVisualConsistency"]
        self.assertEqual(lvc["verificationLayer"], "server_side_layer_decomposition")
        self.assertEqual(lvc["scope"], "selected_slides_partial")
        self.assertEqual(lvc["totalSlides"], 4)
        self.assertEqual(lvc["verifiedSlides"], [2])
        self.assertEqual(lvc["unverifiedSlides"], [0, 1, 3])
        by_idx = {s["slideIndex"]: s for s in lvc["slides"]}
        self.assertEqual(by_idx[2]["status"], "verified")
        self.assertEqual(by_idx[2]["shapeCount"], 10)
        self.assertGreaterEqual(by_idx[2]["ssim"], 0.90)
        self.assertEqual(by_idx[0]["status"], "unverified")
        self.assertEqual(by_idx[3]["status"], "unverified")

        # 2. Resource budget exceeded on slide 2 (maxShapesPerSlide=5) -> explicit skipped_resource_limit
        capped = json.loads(self.run_worker("pptx", "verify", options={"slideIndices": [2], "maxShapesPerSlide": 5}))
        lvc_cap = capped["metrics"]["layerVisualConsistency"]
        self.assertEqual(lvc_cap["skippedByResourceLimitSlides"], [2])
        self.assertEqual(lvc_cap["slides"][2]["status"], "skipped_resource_limit")
        self.assertIn("maxShapesPerSlide", lvc_cap["slides"][2]["reason"])

        # 3. Full-deck verification within resource/time budget -> layer_visual_consistency == passed
        small_prs = Presentation()
        small_prs.slide_width = Inches(10)
        small_prs.slide_height = Inches(5.625)
        for s_idx in range(2):
            sl = small_prs.slides.add_slide(small_prs.slide_layouts[6])
            tb = sl.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(1))
            tb.text_frame.text = f"CompleteDeck-{s_idx + 1}"
        sbuf = io.BytesIO()
        small_prs.save(sbuf)
        self.source.write_bytes(sbuf.getvalue())
        full = json.loads(self.run_worker("pptx", "verify", options={"maxSlides": 4, "maxShapesPerSlide": 12}))
        full_chk = next(c for c in full["checks"] if c["id"] == "layer_visual_consistency")
        self.assertEqual(full_chk["status"], "passed")
        self.assertEqual(full["metrics"]["layerVisualConsistency"]["scope"], "full_deck")
        self.assertEqual(full["metrics"]["layerVisualConsistency"]["verifiedSlides"], [0, 1])

    def test_streaming_xlsx_and_docx_range_reads(self):
        # 1. 250-row XLSX with shared strings
        wb = Workbook()
        ws = wb.active
        ws.title = "BigData"
        for row_idx in range(1, 251):
            ws.cell(row=row_idx, column=1, value=f"RowLabel-{row_idx}")
            ws.cell(row=row_idx, column=2, value=row_idx * 10)
        xbuf = io.BytesIO()
        wb.save(xbuf)
        self.source.write_bytes(xbuf.getvalue())
        xstruct = json.loads(self.run_worker("xlsx", "structure"))
        sheet_id = xstruct["sheets"][0]["id"]
        xrange = json.loads(self.run_worker("xlsx", "range", range={"sheetId": sheet_id, "rangeA1": "A120:B122"}))
        cells_by_ref = {c["address"]: c["value"] for c in xrange["cells"]}
        self.assertEqual(cells_by_ref, {
            "A120": "RowLabel-120", "B120": "1200",
            "A121": "RowLabel-121", "B121": "1210",
            "A122": "RowLabel-122", "B122": "1220",
        })

        # 2. 250-paragraph DOCX streamed via XML.iterparse (250 w:p + 1 trailing w:sectPr = 251 body children)
        doc = Document()
        for p_idx in range(250):
            doc.add_paragraph(f"Paragraph-{p_idx}")
        dbuf = io.BytesIO()
        doc.save(dbuf)
        self.source.write_bytes(dbuf.getvalue())
        drange = json.loads(self.run_worker("docx", "range", range={"start": 120, "count": 3}))
        self.assertEqual(drange["blockCount"], 251)
        self.assertTrue(drange["hasMore"])
        self.assertEqual([b["text"] for b in drange["blocks"]], ["Paragraph-120", "Paragraph-121", "Paragraph-122"])
        self.assertEqual([b["blockIndex"] for b in drange["blocks"]], [120, 121, 122])


