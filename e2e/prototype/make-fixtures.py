"""Real native files, generated only for isolated PR3A browser tests."""
import sys
from io import BytesIO
from pathlib import Path
from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt
from pptx.oxml.xmlchemy import OxmlElement
from PIL import Image
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
book.active["U51"] = "Beyond old grid window"
book.active["C1"] = "=A1+Z900+Other!B50"
book.active["Z900"] = 6
other_sheet = book.create_sheet("Other")
other_sheet["A1"] = "Keep"
other_sheet["B50"] = 13
book.save(out / "sample.xlsx")
doc = Document()
doc.add_paragraph("Introduction")
protected = doc.add_paragraph()
protected.add_run("Keep ").bold = True
protected.add_run("formatting").italic = True
doc.add_table(rows=1, cols=1).cell(0, 0).text = "Keep table"
doc.add_paragraph("Protected\ttext")
doc.add_heading("Editing notes", level=1)
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
# Explicit geometry is painted by the browser, not one full-slide PNG per shape.
# Keep the complex text and rotated shape in the same scene to test Z order.
for index in range(61):
    basic = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.1 + index % 31 * 0.31),
                                   Inches(5 + index // 31 * 0.22), Inches(0.20), Inches(0.15))
    basic.name = f"Basic {index + 1}"
    basic.fill.solid()
    basic.fill.fore_color.rgb = RGBColor(55, 130, 160)
    basic.line.fill.background()
    style = basic._element.find("{http://schemas.openxmlformats.org/presentationml/2006/main}style")
    if style is not None:
        basic._element.remove(style)
group = slide.shapes.add_group_shape()
group.name = "Grouped diagram"
left = group.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(7), Inches(1), Inches(1.3), Inches(1.1))
left.name = "Shadow and transparency"
left.fill.solid()
left.fill.fore_color.rgb = RGBColor(68, 111, 146)
color = left._element.spPr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}solidFill")[0]
alpha = OxmlElement("a:alpha")
alpha.set("val", "62000")
color.append(alpha)
effects = OxmlElement("a:effectLst")
shadow = OxmlElement("a:outerShdw")
shadow.attrib.update({"blurRad": "72000", "dist": "50000", "dir": "2700000"})
shadow_color = OxmlElement("a:srgbClr")
shadow_color.set("val", "202027")
shadow.append(shadow_color)
effects.append(shadow)
left._element.spPr.append(effects)
right = group.shapes.add_shape(MSO_SHAPE.OVAL, Inches(7.8), Inches(1.4), Inches(1.4), Inches(.9))
right.rotation = 18
right.fill.solid()
right.fill.fore_color.rgb = RGBColor(75, 125, 72)
image = BytesIO()
Image.new("RGB", (32, 20), (112, 75, 145)).save(image, "PNG")
image.seek(0)
slide.shapes.add_picture(image, Inches(8.1), Inches(2.7), Inches(1.1), Inches(.7)).name = "Attached image"
table = slide.shapes.add_table(2, 2, Inches(7.15), Inches(3.55), Inches(2.5), Inches(.9))
table.name = "Native table"
for row, values in zip(table.table.rows, [["Metric", "Value"], ["Count", "24"]]):
    for cell, value in zip(row.cells, values):
        cell.text = value
        cell.text_frame.paragraphs[0].runs[0].font.size = Pt(11)
slide.slide_layout.background.fill.solid()
slide.slide_layout.background.fill.fore_color.rgb = RGBColor(240, 244, 249)
deck.save(out / "sample.pptx")
pdf = Canvas(str(out / "sample.pdf"), pagesize=(595, 842), invariant=1)
pdf.drawString(45, 770, "First page")
pdf.showPage()
pdf.setPageSize((960, 540))
pdf.drawString(45, 480, "Wide second page")
pdf.showPage()
pdf.save()
