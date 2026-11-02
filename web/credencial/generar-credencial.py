#!/usr/bin/env python3
"""
generar-credencial.py — Genera el PDF A4 con las dos credenciales para productorxs.

La hoja tiene DOS credenciales independientes (izquierda y derecha); cada una lleva su
par QR + usuario, y los dos pares son obligatorios. Los textos fijos vienen de la página.

No usa la red ni Chrome: lee la MISMA página credencial-a4.html que se imprime desde el
navegador (por defecto, la que está al lado de este script) y la convierte a PDF con
WeasyPrint. Si regenerás la página, el script usa esos cambios: no hay copias.

Requisitos en Debian 13:
    sudo apt install weasyprint python3-qrcode

Uso:
    ./generar-credencial.py --izquierda "QR_IZQ" USUARIO_IZQ --derecha "QR_DER" USUARIO_DER
    ./generar-credencial.py \\
        --izquierda "https://unq.numis.ar/productorxs?u=maria" maria.gonzalez \\
        --derecha   "https://unq.numis.ar/productorxs?u=juan"  juan.perez \\
        -o credenciales.pdf
"""
import argparse
import json
import re
import sys
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

HTML_POR_DEFECTO = Path(__file__).resolve().with_name("credencial-a4.html")


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


def js(v):
    """Número escrito igual que String(v) en JavaScript (52.0 → "52")."""
    v = float(v)
    return str(int(v)) if v.is_integer() else repr(v)


def modulos_qr(texto, lado_mm):
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
    return "".join(d), f"scale({js(lado_mm / n)})"


# ---------------------------------------------------------------------------
# Página y usuario
# ---------------------------------------------------------------------------
def cargar_pagina(ruta):
    """Lee la página y extrae la tabla del usuario (const USR = {...};)."""
    ruta = Path(ruta).expanduser()
    try:
        pagina = ruta.read_text(encoding="utf-8")
    except OSError as e:
        sys.exit(f"Error: no pude leer la página {ruta}: {e.strerror}")
    m = re.search(r"const USR = (\{.*?\});\s*$", pagina, flags=re.M)
    if not m:
        sys.exit(f"Error: {ruta} no tiene la tabla del usuario (const USR = {{...}};).")
    usr = json.loads(m.group(1))
    if not usr.get("lados"):
        sys.exit(f"Error: {ruta} es de una versión anterior. Regenerala con regenerar/regenerar-pagina.py.")
    for lado in usr["lados"]:
        for marca in (f'id="qr-modulos-{lado}"', f'id="texto-usuario-{lado}"'):
            if pagina.count(marca) != 1:
                sys.exit(f"Error: {ruta} no tiene (una sola vez) el elemento {marca}.")
    return pagina, usr


def errores_usuario(usuario, usr):
    errores = []
    malos = list(dict.fromkeys(ch for ch in usuario if ch not in usr["glifos"]))
    if not usuario:
        errores.append("el usuario está vacío")
    if malos:
        errores.append("caracteres no permitidos en el usuario: " +
                       " ".join("(espacio)" if c == " " else c for c in malos))
    if len(usuario) > usr["max"]:
        errores.append(f"el usuario tiene {len(usuario)} caracteres y el máximo es {usr['max']}")
    return errores


def texto_usuario(usuario, usr):
    """Mismo armado que la página (función textoUsuario en el HTML): 1 renglón, o 2 si
    en uno quedaría más chico que esc_una_min."""
    def ancho(s):
        u, prev = 0, None
        for ch in s:
            if prev is not None:
                u += usr["kern"].get(prev + ch, 0)
            u += usr["glifos"][ch]["a"]
            prev = ch
        return u

    n, u = len(usuario), ancho(usuario)
    s = min(usr["esc_una_max"], usr["ancho"] / u)
    if s >= usr["esc_una_min"] or n < 2:
        lineas = [(usuario, -usr["cap"] / 2)]
    else:
        def mejor(cands):
            b = None
            for i in cands:
                m = max(ancho(usuario[:i]), ancho(usuario[i:]))
                if b is None or m < b[1]:
                    b = (i, m)
            return b
        todos = mejor(range(1, n))
        sep = mejor([i for i in range(1, n) if usuario[i - 1] in usr["cortes"]])
        corte = todos
        if sep and 5 * sep[1] <= 6 * todos[1] and min(usr["esc_dos_max"], usr["ancho"] / sep[1]) >= usr["esc_dos_min"]:
            corte = sep
        s = min(usr["esc_dos_max"], usr["ancho"] / corte[1])
        i = corte[0]
        lineas = [(usuario[:i], usr["interlinea"] / 2 - usr["cap"] / 2),
                  (usuario[i:], -usr["interlinea"] / 2 - usr["cap"] / 2)]
    svg = []
    for texto, ty in lineas:
        x, partes, prev = 0, [], None
        for ch in texto:
            if prev is not None:
                x += usr["kern"].get(prev + ch, 0)
            g = usr["glifos"][ch]
            if g["d"]:
                partes.append(f'<path transform="translate({x} 0)" d="{g["d"]}"/>')
            x += g["a"]
            prev = ch
        svg.append(f'<g transform="translate(-{js(x / 2)} {js(ty)})">' + "".join(partes) + "</g>")
    return f"translate({js(usr['cx'])} {js(usr['cy'])}) scale({js(s)} -{js(s)})", "".join(svg)


def main():
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--html", default=str(HTML_POR_DEFECTO))
    pagina, usr = cargar_pagina(pre.parse_known_args()[0].html)
    lados = usr["lados"]

    ap = argparse.ArgumentParser(
        description="Genera el PDF A4 con las dos credenciales para productorxs (sin red ni Chrome). "
                    "Cada credencial lleva su propio par QR + usuario; los " + str(len(lados)) +
                    " pares son obligatorios.")
    for lado in lados:
        ap.add_argument(f"--{lado}", nargs=2, metavar=("QR", "USUARIO"), action="append",
                        help=f"Credencial de la {lado}: el QR (link o texto) y el usuario "
                             f"(hasta {usr['max']} caracteres: letras sin tilde, números y . _ - @ +)")
    ap.add_argument("-o", "--salida", default="credenciales.pdf",
                    help="PDF de salida (por defecto: credenciales.pdf)")
    ap.add_argument("--html", default=str(HTML_POR_DEFECTO),
                    help="Página a usar (por defecto: credencial-a4.html al lado del script)")
    args, sobrantes = ap.parse_known_args()

    uso = "Uso: " + " ".join(f'--{lado} "QR" USUARIO' for lado in lados) + " [-o salida.pdf]"
    opciones = {s for a in ap._actions for s in a.option_strings}
    for lado in lados:                       # un valor faltante hace que se "coma" la opción siguiente
        for qr, usuario in (getattr(args, lado) or []):
            if qr in opciones or usuario in opciones:
                ap.error(f"--{lado} necesita exactamente dos valores (QR y USUARIO). {uso}")
    if sobrantes:
        ap.error("argumentos de más: " + " ".join(sobrantes) +
                 ". Cada credencial lleva exactamente dos valores (QR y USUARIO). " + uso)

    pares, problemas = {}, []
    for lado in lados:
        valores = getattr(args, lado)
        if not valores:
            problemas.append(f"falta --{lado} QR USUARIO")
        elif len(valores) > 1:
            problemas.append(f"--{lado} aparece {len(valores)} veces (va una sola)")
        else:
            pares[lado] = valores[0]
    if problemas:
        ap.error("; ".join(problemas) + ". " + uso)

    errores = []
    for lado, (qr, usuario) in pares.items():
        if not qr.strip():
            errores.append(f"[{lado}] el QR está vacío")
        errores += [f"[{lado}] {e}" for e in errores_usuario(usuario, usr)]
    if errores:
        sys.exit("Error:\n  - " + "\n  - ".join(errores))

    html = pagina
    for lado, (qr, usuario) in pares.items():
        d, escala = modulos_qr(qr, usr["qr_lado"])

        def poner_qr(m, d=d, escala=escala, lado=lado):
            etiqueta = re.sub(r'\s(transform|d)="[^"]*"', "", m.group(0))
            return etiqueta.replace(f'id="qr-modulos-{lado}"',
                                    f'id="qr-modulos-{lado}" transform="{escala}" d="{d}"', 1)
        html = re.sub(rf'<path id="qr-modulos-{lado}"[^>]*>', poner_qr, html, count=1)

        tr, svg = texto_usuario(usuario, usr)
        # el grupo del usuario tiene <g> internos: se reemplaza hasta su cierre real
        inicio = html.index(f'<g id="texto-usuario-{lado}"')
        fin, prof, i = None, 0, inicio
        for m in re.finditer(r"<g\b|</g>", html[inicio:]):
            prof += 1 if m.group(0) == "<g" else -1
            if prof == 0:
                fin = inicio + m.end()
                break
        html = (html[:inicio] + f'<g id="texto-usuario-{lado}" fill="{usr["verde"]}" transform="{tr}">'
                + svg + "</g>" + html[fin:])

    salida = Path(args.salida).expanduser().resolve()
    salida.parent.mkdir(parents=True, exist_ok=True)

    def sin_red(url, *a, **k):   # todo está incrustado en la página: nada externo
        if url.startswith("data:"):
            from weasyprint.urls import default_url_fetcher
            return default_url_fetcher(url, *a, **k)
        raise ValueError("recurso externo bloqueado: " + url)

    # Chrome redondea la hoja A4 a 594.96 x 841.92 pt; se usa la misma medida.
    html = re.sub(r"(@page\s*\{[^}]*?size:\s*)210mm\s+297mm", r"\g<1>594.96pt 841.92pt", html, count=1)
    HTML(string=html, url_fetcher=sin_red, media_type="print").write_pdf(str(salida))
    print(f"PDF generado: {salida}")
    for lado, (qr, usuario) in pares.items():
        print(f"  {lado}: QR={qr!r} · usuario={usuario!r}")


if __name__ == "__main__":
    main()
