"""Small real office/PDF/CSV inputs; all content is a public test fixture."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import sys

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
(out / "values.csv").write_text("name,total\nUpload,42\n", encoding="utf-8")
content_types = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>{}</Types>'
rels = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="{}"/></Relationships>'
with ZipFile(out / "instructions.docx", "w", ZIP_DEFLATED) as doc:
    doc.writestr("[Content_Types].xml", content_types.format('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'))
    doc.writestr("_rels/.rels", rels.format("word/document.xml"))
    doc.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>WORD_INPUT_42</w:t></w:r></w:p></w:body></w:document>')
with ZipFile(out / "totals.xlsx", "w", ZIP_DEFLATED) as sheet:
    sheet.writestr("[Content_Types].xml", content_types.format('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'))
    sheet.writestr("_rels/.rels", rels.format("xl/workbook.xml"))
    sheet.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Totals" sheetId="1" r:id="rId1"/></sheets></workbook>')
    sheet.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
    sheet.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>EXCEL_INPUT</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>')
stream = b"BT /F1 20 Tf 50 750 Td (PDF_INPUT_42) Tj ET"
objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>", b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
pdf = bytearray(b"%PDF-1.4\n")
offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf.extend(str(number).encode() + b" 0 obj\n" + obj + b"\nendobj\n")
xref = len(pdf)
pdf.extend(b"xref\n0 6\n0000000000 65535 f \n")
for offset in offsets[1:]:
    pdf.extend(f"{offset:010} 00000 n \n".encode())
pdf.extend(f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
(out / "reference.pdf").write_bytes(pdf)
