"""Read one bounded document from stdin. Never extract archive members to disk."""
import io
import os
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

LIMIT = 20 * 1024 * 1024
if sys.platform == 'linux':
    import resource
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
    resource.setrlimit(resource.RLIMIT_AS, (384 << 20, 384 << 20))
    resource.setrlimit(resource.RLIMIT_CPU, (8, 9))
    resource.setrlimit(resource.RLIMIT_FSIZE, (4 << 20, 4 << 20))

def extract(ext, data):
    if ext == 'pdf':
        with tempfile.TemporaryDirectory() as d:
            file = os.path.join(d, 'body.txt')
            subprocess.run(['pdftotext', '-enc', 'UTF-8', '-', file], input=data, check=True, timeout=8, stderr=subprocess.DEVNULL)
            with open(file, encoding='utf-8') as f:
                return f.read(240000)
    if ext not in ('docx', 'xlsx'):
        return data.decode('utf-8-sig')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if len(z.infolist()) > 4096 or sum(i.file_size for i in z.infolist()) > LIMIT:
            raise ValueError('oversized archive')
        def xml(name):
            # Office documents do not require a DTD. Reject declarations before parsing.
            raw = z.read(name)
            if b'<!DOCTYPE' in raw.upper() or b'\0' in raw:
                raise ValueError('unsupported XML')
            return ET.fromstring(raw)
        def text(e):
            return ''.join(n.text or '' for n in e.iterfind('.//{*}t'))
        if ext == 'docx':
            return '\n'.join(text(p) for p in xml('word/document.xml').iterfind('.//{*}p'))
        ss = [text(s) for s in xml('xl/sharedStrings.xml')] if 'xl/sharedStrings.xml' in z.namelist() else []
        lines = []
        for sheet in sorted(n for n in z.namelist() if n.startswith('xl/worksheets/') and n.endswith('.xml') and n.count('/') == 2):
            for row in xml(sheet).iterfind('.//{*}row'):
                values = []
                for cell in row.iterfind('{*}c'):
                    v = cell.findtext('{*}v', default='')
                    values.append(ss[int(v)] if cell.get('t') == 's' else text(cell) if cell.get('t') == 'inlineStr' else v)
                lines.append(' | '.join(values))
        return '\n'.join(lines)

if __name__ == '__main__':
    data = sys.stdin.buffer.read(LIMIT + 1)
    if len(data) > LIMIT:
        sys.exit(2)
    sys.stdout.buffer.write(extract(sys.argv[1], data)[:240000].replace('\0', '').encode('utf-8'))
