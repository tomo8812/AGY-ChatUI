"""Real native files, generated only for isolated PR3A browser tests."""
import sys
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt
from reportlab.pdfgen.canvas import Canvas

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
(out / "notes.md").write_text("# Notes\n\nOriginal text\n", encoding="utf-8")
(out / "main.ts").write_text("export const original = 7;\n", encoding="utf-8")
(out / "sample.csv").write_text("Item,Quantity\nApple,7\n", encoding="utf-8")
book = Workbook()
book.active.title = "Sheet1"
book.active["A1"] = 7
book.active["B1"] = "=A1*2"
book.create_sheet("Other")["A1"] = "Keep"
book.save(out / "sample.xlsx")
doc = Document()
doc.add_paragraph("Introduction")
protected = doc.add_paragraph()
protected.add_run("Keep ").bold = True
protected.add_run("formatting").italic = True
doc.add_table(rows=1, cols=1).cell(0, 0).text = "Keep table"
doc.add_paragraph("Protected\ttext")
doc.save(out / "sample.docx")
deck = Presentation()
deck.slide_width = Inches(10)
deck.slide_height = Inches(5.625)
slide = deck.slides.add_slide(deck.slide_layouts[6])
shape = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(1), Inches(4), Inches(2))
shape.name = "Title"
shape.fill.solid()
shape.fill.fore_color.rgb = RGBColor(26, 79, 130)
shape.text = "Original title"
shape.text_frame.paragraphs[0].runs[0].font.size = Pt(25)
shape.text_frame.paragraphs[0].runs[0].font.color.rgb = RGBColor(255, 255, 255)
other = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(4), Inches(2.4), Inches(3), Inches(1.8))
other.name = "Overlap"
other.fill.solid()
other.fill.fore_color.rgb = RGBColor(172, 89, 39)
other.rotation = 9
deck.save(out / "sample.pptx")
pdf = Canvas(str(out / "sample.pdf"), pagesize=(595, 842), invariant=1)
pdf.drawString(45, 770, "First page")
pdf.showPage()
pdf.setPageSize((960, 540))
pdf.drawString(45, 480, "Wide second page")
pdf.showPage()
pdf.save()
