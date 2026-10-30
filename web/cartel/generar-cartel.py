#!/usr/bin/env python3
"""
generar-cartel.py — Genera el PDF A4 del cartel QR plegable (2 carteles por hoja).

No usa la red ni Chrome: lee la MISMA página imprimir-qr-a4.html que se imprime desde
el navegador (por defecto, la que está al lado de este script) y la convierte a PDF
con WeasyPrint. Si modificás la página, el script usa esos cambios: no hay copias.
De la página también toma la tabla de letras del texto editable y su máximo. Toda la hoja es un único dibujo SVG
en milímetros (textos ya convertidos a trazos y logos incrustados), así que no
depende de tipografías instaladas. El QR se arma con el mismo algoritmo que la
página, así que sale idéntico módulo a módulo.

Requisitos en Debian 13:
    sudo apt install weasyprint python3-qrcode

Uso:
    ./generar-cartel.py "TEXTO DEL QR"
    ./generar-cartel.py "taler://pay/..." -t "Pagá con tu billetera" -o puesto-12.pdf
    ./generar-cartel.py "taler://pay/..." --html /otra/ruta/imprimir-qr-a4.html
    ./generar-cartel.py -t "Venta de zapas \U0001F600" -o zapas.pdf "taler://pay-template/..."
    ./generar-cartel.py -t "Venta de zapas :athletic_shoe:" -o zapas.pdf "taler://..."
    ./generar-cartel.py --buscar-emoji zapa

Emojis: se toman de la carpeta emojis/ (Twemoji, al lado de la página), solo los
que usa cada cartel. Ver LEEME.md.
"""
import argparse
import difflib
import json
import re
import sys
import urllib.parse
from pathlib import Path

try:
    import qrcode
    from qrcode.util import QRData, MODE_8BIT_BYTE
except ImportError:
    sys.exit("Falta python3-qrcode. Instalalo con: sudo apt install python3-qrcode")
try:
    from weasyprint import HTML
except ImportError:
    sys.exit("Falta WeasyPrint. Instalalo con: sudo apt install weasyprint")

VERDE = "#064d2d"
SUB_SIGNOS = ". , : ; ! ¡ ? ¿ - ' ( ) / & + @ # $ % ·"


# ---------------------------------------------------------------------------
# QR idéntico al de la página (librería JS qrcode-generator, nivel M, modo byte UTF-8).
# python3-qrcode arma la misma matriz; solo cambia cómo elige la máscara, así que
# acá se usa el mismo puntaje que la librería JS.
# ---------------------------------------------------------------------------
def _penalidad(m):
    n = len(m)
    p = 0.0
    for r in range(n):
        for c in range(n):
            d = m[r][c]
            s = 0
            for dr in (-1, 0, 1):
                rr = r + dr
                if rr < 0 or rr >= n:
                    continue
                for dc in (-1, 0, 1):
                    cc = c + dc
                    if cc < 0 or cc >= n or (dr == 0 and dc == 0):
                        continue
                    if m[rr][cc] == d:
                        s += 1
            if s > 5:
                p += 3 + s - 5
    for r in range(n - 1):
        for c in range(n - 1):
            k = m[r][c] + m[r + 1][c] + m[r][c + 1] + m[r + 1][c + 1]
            if k == 0 or k == 4:
                p += 3
    patron = (True, False, True, True, True, False, True)
    for r in range(n):
        fila = m[r]
        for c in range(n - 6):
            if tuple(fila[c:c + 7]) == patron:
                p += 40
    for c in range(n):
        col = [m[r][c] for r in range(n)]
        for r in range(n - 6):
            if tuple(col[r:r + 7]) == patron:
                p += 40
    oscuros = sum(sum(1 for v in fila if v) for fila in m)
    p += abs(100 * oscuros / n / n - 50) / 5 * 10
    return p


class _QRComoLaPagina(qrcode.QRCode):
    def best_mask_pattern(self):
        mejor, minimo = 0, 0
        for i in range(8):
            self.makeImpl(True, i)
            lp = _penalidad([[bool(v) for v in fila] for fila in self.modules])
            if i == 0 or minimo > lp:
                minimo, mejor = lp, i
        return mejor


def modulos_qr(texto):
    """Devuelve (d, escala) exactamente como lo arma la página en JavaScript."""
    q = _QRComoLaPagina(version=None, error_correction=qrcode.constants.ERROR_CORRECT_M, border=0)
    q.add_data(QRData(texto.encode("utf-8"), mode=MODE_8BIT_BYTE))
    q.make(fit=True)
    n = q.modules_count
    d = []
    for r in range(n):
        c = 0
        while c < n:
            if not q.modules[r][c]:
                c += 1
                continue
            k = c
            while k < n and q.modules[r][k]:
                k += 1
            d.append(f"M{c} {r}h{k - c}v1h-{k - c}z")
            c = k
    return "".join(d), f"scale({46 / n!r})"


# ---------------------------------------------------------------------------
# Lectura de la página compartida y del índice de emojis
# ---------------------------------------------------------------------------
HTML_POR_DEFECTO = Path(__file__).resolve().with_name("imprimir-qr-a4.html")
SUB = None                                   # se carga desde la página
EMOJI = {"archivos": {}, "shortcodes": {}}   # se carga desde emojis/indice.js
EMOJI_LARGO = 1


def cargar_pagina(ruta):
    """Lee la página y extrae la tabla del texto editable (const SUB = {...};)."""
    global SUB
    ruta = Path(ruta).expanduser()
    try:
        pagina = ruta.read_text(encoding="utf-8")
    except OSError as e:
        sys.exit(f"Error: no pude leer la página {ruta}: {e.strerror}")
    m = re.search(r"const SUB = (\{.*?\});\s*$", pagina, flags=re.M)
    if not m:
        sys.exit(f"Error: {ruta} no tiene la tabla del texto (const SUB = {{...}};).")
    SUB = json.loads(m.group(1))
    for marca in ('id="qr-modulos"', 'id="texto-sub"'):
        if marca not in pagina:
            sys.exit(f"Error: {ruta} no tiene el elemento {marca}.")
    return pagina


def cargar_emojis(carpeta):
    """Lee emojis/indice.js (qué emojis hay y sus shortcodes). Los SVG se leen bajo demanda."""
    global EMOJI, EMOJI_LARGO
    indice = carpeta / "indice.js"
    if not indice.exists():
        return False
    m = re.search(r"window\.TWEMOJI = (\{.*\});\s*$", indice.read_text(encoding="utf-8"), flags=re.M)
    if not m:
        sys.exit(f"Error: {indice} no tiene el formato esperado.")
    EMOJI = json.loads(m.group(1))
    EMOJI_LARGO = max(len(k) for k in EMOJI["archivos"])
    return True


# ---------------------------------------------------------------------------
# Texto debajo del QR: mismos pasos que la página (ver comentario en el HTML)
# ---------------------------------------------------------------------------
def preparar_texto(cadena):
    errores = []

    def escape(m):
        cp = int(m.group(1) or m.group(2), 16)
        if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
            errores.append("código inválido: " + m.group(0))
            return ""
        return chr(cp)
    s = re.sub(r"\\U([0-9a-fA-F]{8})|\\u([0-9a-fA-F]{4})", escape, cadena)

    def shortcode(m):
        e = EMOJI["shortcodes"].get(m.group(1).lower())
        if e is None:
            q = m.group(1).lower()
            candidatos = [n for n in EMOJI["shortcodes"] if n.startswith(q[:4]) or q in n] or list(EMOJI["shortcodes"])
            parecidos = sorted(candidatos, key=lambda n: -difflib.SequenceMatcher(None, q, n).ratio())[:4]
            errores.append(f"shortcode desconocido: {m.group(0)}"
                           + (" (¿quisiste decir " + ", ".join(f":{p}:" for p in parecidos) + "?)" if parecidos else ""))
            return m.group(0)
        return e
    s = re.sub(r":([a-z0-9_+\-]+):", shortcode, s, flags=re.I)
    return s.replace("️", ""), errores


def segmentar(s):
    partes, malos, i = [], [], 0
    while i < len(s):
        largo = 0
        for k in range(min(EMOJI_LARGO, len(s) - i), 0, -1):
            if s[i:i + k] in EMOJI["archivos"]:
                largo = k
                break
        may = s[i].upper()
        if largo > 1 or (largo == 1 and may not in SUB["glifos"]):
            partes.append(("emoji", EMOJI["archivos"][s[i:i + largo]]))
        elif may in SUB["glifos"]:
            partes.append(("letra", may))
            largo = 1
        else:
            malos.append(s[i])
            largo = 1
        i += largo
    return partes, malos


def analizar_texto(cadena):
    s, errores = preparar_texto(cadena)
    partes, malos = segmentar(s)
    if malos:
        errores.append("caracteres no permitidos: " + " ".join(dict.fromkeys(malos)))
    if len(partes) > SUB["max"]:
        errores.append(f"tiene {len(partes)} caracteres y el máximo es {SUB['max']} (cada emoji cuenta 1)")
    return partes, errores


def _mitad(u):
    """u/2 escrito igual que String(u / 2) en JavaScript."""
    return str(u // 2) if u % 2 == 0 else repr(u / 2)


def texto_sub(partes, carpeta_emojis):
    u, svg, prev = 0, [], None
    e = SUB["emoji"]
    for i, (tipo, valor) in enumerate(partes):
        if i > 0:
            u += SUB["espaciado"] + (SUB["kern"].get(prev + valor, 0) if tipo == "letra" and prev else 0)
        if tipo == "letra":
            g = SUB["glifos"][valor]
            if g["d"]:
                svg.append(f'<path transform="translate({u} 0)" d="{g["d"]}"/>')
            u += g["a"]
            prev = valor
        else:
            href = (carpeta_emojis / f"{valor}.svg").as_uri()
            svg.append(f'<image href="{href}" width="{e["lado"]}" height="{e["lado"]}" '
                       f'transform="translate({u} {e["arriba"]}) scale(1 -1)"/>')
            u += e["lado"]
            prev = None
    tr = (f"translate({SUB['x']} {SUB['base']}) scale({SUB['escala']} -{SUB['escala']}) "
          f"translate(-{_mitad(u)} 0)")
    return f'<g id="texto-sub" fill="#fff" transform="{tr}">' + "".join(svg) + "</g>"


def buscar_emojis(consulta):
    q = consulta.strip().lower().strip(":")
    nombres = sorted((n for n in EMOJI["shortcodes"] if q in n),
                     key=lambda n: (not n.startswith(q), len(n), n))
    vistos = {}
    for n in nombres:
        vistos.setdefault(EMOJI["shortcodes"][n], []).append(n)
    return list(vistos.items())


def main():
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--html", default=str(HTML_POR_DEFECTO))
    pre.add_argument("--emojis", default=None)
    previo = pre.parse_known_args()[0]
    pagina = cargar_pagina(previo.html)
    carpeta_emojis = Path(previo.emojis or Path(previo.html).expanduser().resolve().parent / SUB["emoji"]["carpeta"])
    carpeta_emojis = carpeta_emojis.expanduser().resolve()
    hay_emojis = cargar_emojis(carpeta_emojis)

    ap = argparse.ArgumentParser(
        description="Genera el PDF A4 del cartel QR (sin red ni Chrome).",
        epilog="El texto acepta emojis: pegados, como shortcode (:grinning:, :zapatilla_deportiva:) "
               "o como código (\\U0001F600). Usá --buscar-emoji para encontrar shortcodes.")
    ap.add_argument("qr", nargs="?", help="Texto o link que va dentro del QR (obligatorio)")
    ap.add_argument("-t", "--texto", default=None,
                    help=f"Texto debajo del QR, hasta {SUB['max']} caracteres; cada emoji cuenta 1 "
                         f"(por defecto: \"{SUB['defecto']}\")")
    ap.add_argument("-o", "--salida", default="cartel-qr.pdf", help="PDF de salida (por defecto: cartel-qr.pdf)")
    ap.add_argument("--html", default=str(HTML_POR_DEFECTO),
                    help="Página del cartel a usar (por defecto: imprimir-qr-a4.html al lado del script)")
    ap.add_argument("--emojis", default=None,
                    help="Carpeta de emojis (por defecto: la carpeta emojis/ al lado de la página)")
    ap.add_argument("--buscar-emoji", metavar="TEXTO", help="Lista los emojis cuyo shortcode contiene TEXTO y sale")
    args = ap.parse_args()

    if args.buscar_emoji is not None:
        if not hay_emojis:
            sys.exit(f"Error: no encontré {carpeta_emojis / 'indice.js'}.")
        hallados = buscar_emojis(args.buscar_emoji)
        for emoji, nombres in hallados[:60]:
            print(f"{emoji}  " + "  ".join(f":{n}:" for n in nombres[:4]))
        if len(hallados) > 60:
            print(f"… y {len(hallados) - 60} más; afiná la búsqueda.")
        if not hallados:
            print("Sin resultados.")
        return

    if args.qr is None or not args.qr.strip():
        ap.error("falta el texto del QR (o está vacío)")

    texto = SUB["defecto"] if args.texto is None else args.texto
    partes, errores = analizar_texto(texto)
    if errores:
        aviso = "" if hay_emojis else f"\n(No encontré {carpeta_emojis / 'indice.js'}: sin emojis disponibles.)"
        sys.exit("Error en el texto debajo del QR:\n  - " + "\n  - ".join(errores) + "\n"
                 "Se permiten letras (se pasan a mayúsculas), números, espacio, " + SUB_SIGNOS +
                 " y emojis." + aviso)

    d, escala = modulos_qr(args.qr)
    def poner_qr(m):
        etiqueta = re.sub(r'\s(transform|d)="[^"]*"', "", m.group(0))
        return etiqueta.replace('id="qr-modulos"', f'id="qr-modulos" transform="{escala}" d="{d}"', 1)
    html = re.sub(r'<path id="qr-modulos"[^>]*>', poner_qr, pagina, count=1)
    html = re.sub(r'<g id="texto-sub"[^>]*>.*?</g>', lambda m: texto_sub(partes, carpeta_emojis),
                  html, count=1, flags=re.S)
    html = re.sub(r'<image id="qr-imagen"[^>]*/>', "", html, count=1)   # solo se usa en la página

    salida = Path(args.salida).expanduser().resolve()
    salida.parent.mkdir(parents=True, exist_ok=True)

    # Sin red: solo se aceptan datos incrustados y los SVG de la carpeta de emojis.
    def sin_red(url, *a, **k):
        from weasyprint.urls import default_url_fetcher
        if url.startswith("data:"):
            return default_url_fetcher(url, *a, **k)
        if url.startswith("file:"):
            ruta = Path(urllib.parse.unquote(urllib.parse.urlparse(url).path)).resolve()
            if ruta.suffix == ".svg" and ruta.parent == carpeta_emojis:
                return default_url_fetcher(url, *a, **k)
        raise ValueError("recurso externo bloqueado: " + url)

    # Chrome redondea la hoja A4 a 594.96 x 841.92 pt; se usa la misma medida.
    html = re.sub(r"(@page\s*\{[^}]*?size:\s*)210mm\s+297mm", r"\g<1>594.96pt 841.92pt", html, count=1)
    HTML(string=html, url_fetcher=sin_red, media_type="print",
         base_url=Path(previo.html).expanduser().resolve().parent.as_uri() + "/").write_pdf(str(salida))
    print(f"PDF generado: {salida}")


if __name__ == "__main__":
    main()
