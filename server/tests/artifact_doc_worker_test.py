"""Real file round trips for the document worker.

Run using the Compact or Full runtime:
  /opt/agy-doc-runtime/venv/bin/python3 -m unittest discover -s server/tests -p artifact_doc_worker_test.py
"""

import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from docx import Document
from lxml import etree as XML
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, Reference
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
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
        subprocess.run([sys.executable, str(WORKER)], env=env, check=True, cwd=self.directory)
        return self.result.read_bytes()

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

    @unittest.skipUnless(os.environ.get("AGY_TEST_SMARTART_FILE"), "External SmartArt fixture not supplied")
    def test_real_smartart_updates_data_and_cached_drawing(self):
        # Apache POI test-data/slideshow/smartart-simple.pptx.
        shutil.copyfile(os.environ["AGY_TEST_SMARTART_FILE"], self.source)
        result = self.run_worker("pptx", "edit", operations=[{
            "op": "pptx.smartart.update_node_text",
            "slidePart": "ppt/slides/slide1.xml",
            "dataPart": "ppt/diagrams/data1.xml",
            "nodeId": "{63986E3B-5608-7F48-A1F2-C2D1F88EED58}",
            "text": "Updated SmartArt Label",
        }])
        with zipfile.ZipFile(io.BytesIO(result)) as package:
            for part in ("ppt/diagrams/data1.xml", "ppt/diagrams/drawing1.xml"):
                self.assertIn(b"Updated SmartArt Label", package.read(part))
        self.assertTrue(Presentation(io.BytesIO(result)).slides)

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
            {"op": "chart.update_series_data", "chartPart": chart_part, "seriesIndex": 0, "values": [3, 5, 7]},
        ])
        chart = Presentation(io.BytesIO(result)).slides[0].shapes[0].chart
        self.assertEqual(list(chart.series[0].values), [3, 5, 7])
        with zipfile.ZipFile(io.BytesIO(result)) as package:
            workbook_part = next(name for name in package.namelist() if name.endswith(".xlsx"))
            book = load_workbook(io.BytesIO(package.read(workbook_part)))
            self.assertEqual([book.active[f"B{row}"].value for row in range(2, 5)], [3, 5, 7])

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
