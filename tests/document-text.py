"""Run with python tests/document-text.py; fixtures are generated in memory."""
import io
import subprocess
import sys
import zipfile

def extract(kind, data):
    return subprocess.check_output([sys.executable, '-I', 'scripts/document-text.py', kind], input=data).decode()

def office(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()

def pdf():
    stream = b'BT /F1 12 Tf 30 80 Td (Payment term: NET45) Tj ET'
    objects = [b'<</Type/Catalog/Pages 2 0 R>>', b'<</Type/Pages/Kids[3 0 R]/Count 1>>', b'<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', b'<</Length '+str(len(stream)).encode()+b'>>\nstream\n'+stream+b'\nendstream', b'<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>']
    data=b'%PDF-1.4\n'; offsets=[0]
    for i, obj in enumerate(objects,1):
        offsets.append(len(data)); data += f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
    xref=len(data); data+=b'xref\n0 6\n0000000000 65535 f \n'
    for off in offsets[1:]: data+=f'{off:010d} 00000 n \n'.encode()
    return data + f'trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF'.encode()

if __name__=='__main__':
    if '--pdf' in sys.argv: sys.stdout.buffer.write(pdf()); sys.exit()
    assert 'NET45' in extract('pdf',pdf())
    assert extract('docx',office({'word/document.xml':'<w:document xmlns:w="urn:word"><w:p><w:r><w:t>交付日期：</w:t></w:r><w:r><w:t>周五</w:t></w:r></w:p></w:document>'}))=='交付日期：周五'
    assert extract('xlsx',office({'xl/sharedStrings.xml':'<sst><si><t>报价</t></si></sst>', 'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>70000</v></c></row></sheetData></worksheet>'}))=='报价 | 70000'
    print('PASS: PDF text layer, Word paragraphs and Excel shared strings with numeric cells')
