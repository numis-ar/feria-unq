#!/usr/bin/env python3
"""
regenerar-pagina.py — Vuelve a armar ../imprimir-qr-a4.html a partir de plantilla.html.

Toda la hoja del cartel es un único dibujo SVG en milímetros. Los textos se guardan
como trazos (no como letras), así se ven idénticos en el navegador y en el PDF del
script sin depender de tipografías instaladas. Este programa hace esa conversión.

Para cambiar textos, colores o medidas: editá la sección CONFIGURACIÓN de abajo y
ejecutá:

    python3 regenerar-pagina.py

Requisitos en Debian 13:  sudo apt install python3-fonttools
No usa la red. Ver LEEME.md para el instructivo completo.
"""
import json
import re
import sys
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
except ImportError:
    sys.exit("Falta fontTools. Instalalo con: sudo apt install python3-fonttools")

AQUI = Path(__file__).resolve().parent

# =============================================================================
# CONFIGURACIÓN — lo que normalmente vas a querer cambiar
# =============================================================================

# Textos fijos (se convierten a trazos)
TITULO = ["ESCANEÁ Y", "PAGÁ"]                      # una entrada por renglón
PIE = "Con la app de"                                # a la izquierda del logo de Taler
SOLAPA = "Solapa de base · doblar hacia adentro"     # texto gris de las solapas M

# Valores por defecto de la página (los dos se pueden cambiar al usarla)
QR_DEFECTO = "https://unq.numis.ar/puesto-test"
SUB_DEFECTO = "Desde tu celular"                     # texto editable debajo del QR

# Colores
VERDE = "#064d2d"        # fondo de las caras y color del QR
CREMA = "#f6f7f2"        # franja del pie
GUIA = "#a8a8a8"         # líneas de doblez y texto de las solapas
CORTE = "#d0d0d0"        # línea de corte entre las dos secciones

# Logos (archivos SVG en la carpeta logos/)
LOGO_ARRIBA = "logos/numis-logo-sobre-verde.svg"
LOGO_PIE = "logos/taler-logo-2021.svg"

# Tipografía (archivos en fuentes/, por peso)
FUENTES = {600: "fuentes/Montserrat-SemiBold.ttf", 700: "fuentes/Montserrat-Bold.ttf",
           800: "fuentes/Montserrat-ExtraBold.ttf", 900: "fuentes/Montserrat-Black.ttf"}

# Caracteres que se pueden escribir en el texto editable debajo del QR.
# (Las minúsculas se aceptan y se pasan a mayúsculas.)
PERMITIDOS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ÁÉÍÓÚÜÑ.,:;!¡?¿-'()/&+@#$%·"

# =============================================================================
# MEDIDAS — en milímetros. Hoja A4 = 2 secciones de 105 mm de ancho; cada una:
#   solapa M (25) · cara B invertida (123,5) · cara A (123,5) · solapa M (25)
# Las coordenadas de la cara son relativas a su esquina superior izquierda.
# =============================================================================
W, H, M, CARA = 105, 297, 25, 123.5

LOGO_ARRIBA_CAJA = (27.25, 6, 50.5, 11)              # x, y, ancho, alto
TITULO_PESO, TITULO_TAM = 900, 10.2                  # cuerpo en mm
TITULO_BASES = [29.76, 39.96]                        # línea de base de cada renglón
QR_CAJA = (25.5, 46, 54, 4)                          # x, y, lado del recuadro blanco, radio
QR_MARGEN = 4                                        # blanco alrededor del QR (QR = 54 - 2*4 = 46)
SUB_PESO = 600
SUB_ESCALA = "0.0034"                                # cuerpo 3,4 mm (fuente de 1000 unidades)
SUB_ESPACIADO = 103                                  # espaciado entre letras (unidades de la fuente)
SUB_X, SUB_BASE = 52.5, 105.2                        # centro y línea de base
SUB_ANCHO_MAX = 93                                   # ancho disponible: define el máximo de caracteres
EMOJI_LADO = 1000                                    # emoji: cuadrado de 1 em (3,4 mm), en unidades de la fuente
EMOJI_ARRIBA = 850                                   # borde superior del emoji sobre la línea de base
                                                     # (queda centrado en la altura de las mayúsculas)
PIE_Y, PIE_ALTO = 109.5, 14
PIE_PESO, PIE_TAM, PIE_X_DERECHA, PIE_BASE = 700, 3.3, 58, 117.68
LOGO_PIE_CAJA = (60.5, 113, 15.6, 7)
SOLAPA_PESO, SOLAPA_TAM, SOLAPA_BASE = 600, 2.6, 13.43

ANCHO_SEGURO = (4, W - 4)                            # aviso si un texto fijo se sale de acá

SALIDA = AQUI.parent / "imprimir-qr-a4.html"

# =============================================================================
# Fin de la configuración
# =============================================================================


def f(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


# ---------- Tipografía: glifos, avances y kerning (tabla GPOS 'kern') ----------
class Fuente:
    def __init__(self, ruta):
        self.tt = TTFont(AQUI / ruta)
        self.upem = self.tt["head"].unitsPerEm
        self.cmap = self.tt.getBestCmap()
        self.hmtx = self.tt["hmtx"]
        self.gs = self.tt.getGlyphSet()
        self.lookups = self._lookups_kern()

    def _lookups_kern(self):
        if "GPOS" not in self.tt:
            return []
        gpos = self.tt["GPOS"].table
        indices = set()
        for fr in gpos.FeatureList.FeatureRecord:
            if fr.FeatureTag == "kern":
                indices.update(fr.Feature.LookupListIndex)
        lookups = []
        for i in sorted(indices):
            lk = gpos.LookupList.Lookup[i]
            subs = []
            for st in lk.SubTable:
                tipo = lk.LookupType
                if tipo == 9:                     # Extension: el subtable real está adentro
                    tipo, st = st.ExtensionLookupType, st.ExtSubTable
                if tipo == 2:                     # PairPos (kerning entre pares)
                    subs.append(st)
            lookups.append(subs)
        return lookups

    def glifo(self, ch):
        try:
            return self.cmap[ord(ch)]
        except KeyError:
            sys.exit(f"Error: la fuente no tiene el carácter {ch!r}.")

    def avance(self, g):
        return self.hmtx[g][0]

    def kern(self, g1, g2):
        total = 0
        for subs in self.lookups:
            for st in subs:
                if g1 not in st.Coverage.glyphs:
                    continue
                if st.Format == 1:
                    ps = st.PairSet[st.Coverage.glyphs.index(g1)]
                    rec = next((r for r in ps.PairValueRecord if r.SecondGlyph == g2), None)
                    if rec is None:
                        continue          # este subtable no tiene el par: probar el siguiente
                    total += (getattr(rec.Value1, "XAdvance", 0) or 0) if rec.Value1 else 0
                    break
                if st.Format == 2:
                    c1 = st.ClassDef1.classDefs.get(g1, 0)
                    c2 = st.ClassDef2.classDefs.get(g2, 0)
                    v = st.Class1Record[c1].Class2Record[c2].Value1
                    total += (getattr(v, "XAdvance", 0) or 0) if v else 0
                    break
        return total

    def trazo(self, g, transformacion=None):
        pen = SVGPathPen(self.gs, ntos=f)
        self.gs[g].draw(TransformPen(pen, transformacion) if transformacion else pen)
        return pen.getCommands()


FUENTE = {peso: Fuente(ruta) for peso, ruta in FUENTES.items()}


def medir(cadena, fu):
    """Avances (con kerning) en unidades de la fuente."""
    glifos = [fu.glifo(ch) for ch in cadena]
    pos, x = [], 0
    for i, g in enumerate(glifos):
        if i:
            x += fu.kern(glifos[i - 1], g)
        pos.append(x)
        x += fu.avance(g)
    return glifos, pos, x


def texto(cadena, peso, tam, x, base, alinear="center", nombre="texto"):
    """Path SVG (en mm) de un texto fijo con kerning, base = línea de base."""
    fu = FUENTE[peso]
    glifos, pos, ancho_u = medir(cadena, fu)
    k = tam / fu.upem
    ancho = ancho_u * k
    x0 = {"center": x - ancho / 2, "right": x - ancho, "left": x}[alinear]
    if x0 < ANCHO_SEGURO[0] - 1e-9 or x0 + ancho > ANCHO_SEGURO[1] + 1e-9:
        print(f"AVISO: {nombre} ({cadena!r}) mide {ancho:.1f} mm y se sale del área segura "
              f"({ANCHO_SEGURO[0]}–{ANCHO_SEGURO[1]} mm).")
    return "".join(fu.trazo(g, (k, 0, 0, -k, x0 + p * k, base)) for g, p in zip(glifos, pos))


# ---------- Texto editable: tabla compartida con la página y el script ----------
def tabla_sub():
    fu = FUENTE[SUB_PESO]
    glifos = {}
    for ch in PERMITIDOS:
        g = fu.glifo(ch)
        glifos[ch] = {"a": fu.avance(g), "d": fu.trazo(g)}
    kern = {}
    for a in PERMITIDOS:
        for b in PERMITIDOS:
            k = fu.kern(fu.glifo(a), fu.glifo(b))
            if k:
                kern[a + b] = k
    return glifos, kern


GLIFOS, KERN = tabla_sub()


def maximo_caracteres():
    """Mayor n tal que CUALQUIER combinación de n caracteres permitidos (letras o emojis)
    entra en el ancho. Programación dinámica sobre el peor caso exacto (ancho + kerning +
    espaciado). Un emoji cuenta como 1 carácter, mide EMOJI_LADO y no tiene kerning."""
    limite = round(SUB_ANCHO_MAX / float(SUB_ESCALA))
    anchos = {c: g["a"] for c, g in GLIFOS.items()}
    anchos["<emoji>"] = EMOJI_LADO
    peor = dict(anchos)
    n = 0
    while max(peor.values()) <= limite:
        n += 1
        peor = {c: max(peor[p] + SUB_ESPACIADO + KERN.get(p + c, 0) for p in anchos) + anchos[c]
                for c in anchos}
    return n


SUB_MAX = maximo_caracteres()


def _mitad(u):
    return str(u // 2) if u % 2 == 0 else repr(u / 2)


def texto_sub(cadena):
    """El mismo armado que hacen la página (JS) y generar-cartel.py."""
    u, partes, prev = 0, [], None
    for ch in cadena.upper():
        if prev is not None:
            u += SUB_ESPACIADO + KERN.get(prev + ch, 0)
        g = GLIFOS[ch]
        if g["d"]:
            partes.append(f'<path transform="translate({u} 0)" d="{g["d"]}"/>')
        u += g["a"]
        prev = ch
    tr = f"translate({SUB_X} {SUB_BASE}) scale({SUB_ESCALA} -{SUB_ESCALA}) translate(-{_mitad(u)} 0)"
    return f'<g id="texto-sub" fill="#fff" transform="{tr}">' + "".join(partes) + "</g>"


# ---------- Logos y formas ----------
def logo(ruta, x, y, w, h):
    svg = (AQUI / ruta).read_text(encoding="utf-8")
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', svg).group(1).replace(",", " ").split()]
    s = min(w / vb[2], h / vb[3])
    cuerpo = re.sub(r"<metadata>.*?</metadata>", "", svg, flags=re.S)
    cuerpo = re.sub(r"<\?xml.*?\?>", "", cuerpo, flags=re.S)
    cuerpo = re.sub(r"^.*?<svg[^>]*>", "", cuerpo, flags=re.S)
    cuerpo = re.sub(r"</svg>\s*$", "", cuerpo.strip())

    def circulo(m):  # los círculos se pasan a curvas explícitas (se dibujan igual en todos lados)
        a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(0)))
        cx, cy, r = float(a["cx"]), float(a["cy"]), float(a["r"])
        k = r * 0.5522847498
        d = (f"M{cx + r:.6f} {cy:.6f}C{cx + r:.6f} {cy + k:.6f} {cx + k:.6f} {cy + r:.6f} {cx:.6f} {cy + r:.6f}"
             f"C{cx - k:.6f} {cy + r:.6f} {cx - r:.6f} {cy + k:.6f} {cx - r:.6f} {cy:.6f}"
             f"C{cx - r:.6f} {cy - k:.6f} {cx - k:.6f} {cy - r:.6f} {cx:.6f} {cy - r:.6f}"
             f"C{cx + k:.6f} {cy - r:.6f} {cx + r:.6f} {cy - k:.6f} {cx + r:.6f} {cy:.6f}Z")
        return f'<path fill="{a.get("fill", "#000")}" d="{d}"/>'
    cuerpo = re.sub(r"<circle[^>]*>(</circle>)?", circulo, cuerpo)
    ox, oy = x + (w - vb[2] * s) / 2, y + (h - vb[3] * s) / 2
    return f'<g transform="translate({f(ox)} {f(oy)}) scale({s:.6f}) translate({f(-vb[0])} {f(-vb[1])})">{cuerpo}</g>'


def rect_redondeado(x, y, w, h, r):
    k = r * 0.5522847498
    return (f"M{f(x + r)} {f(y)}H{f(x + w - r)}C{f(x + w - r + k)} {f(y)} {f(x + w)} {f(y + r - k)} {f(x + w)} {f(y + r)}"
            f"V{f(y + h - r)}C{f(x + w)} {f(y + h - r + k)} {f(x + w - r + k)} {f(y + h)} {f(x + w - r)} {f(y + h)}"
            f"H{f(x + r)}C{f(x + r - k)} {f(y + h)} {f(x)} {f(y + h - r + k)} {f(x)} {f(y + h - r)}"
            f"V{f(y + r)}C{f(x)} {f(y + r - k)} {f(x + r - k)} {f(y)} {f(x + r)} {f(y)}Z")


def armar_hoja():
    qx, qy, lado, radio = QR_CAJA
    cara = "".join([
        f'<rect width="{W}" height="{CARA}" fill="{VERDE}"/>',
        logo(LOGO_ARRIBA, *LOGO_ARRIBA_CAJA),
        '<path fill="#fff" d="' + "".join(
            texto(r, TITULO_PESO, TITULO_TAM, W / 2, b, nombre=f"TITULO[{i}]")
            for i, (r, b) in enumerate(zip(TITULO, TITULO_BASES))) + '"/>',
        '<use href="#qr" xlink:href="#qr"/>',
        texto_sub(SUB_DEFECTO),
        f'<rect y="{PIE_Y}" width="{W}" height="{PIE_ALTO}" fill="{CREMA}"/>',
        f'<path fill="{VERDE}" d="{texto(PIE, PIE_PESO, PIE_TAM, PIE_X_DERECHA, PIE_BASE, "right", "PIE")}"/>',
        logo(LOGO_PIE, *LOGO_PIE_CAJA),
    ])
    solapa = texto(SOLAPA, SOLAPA_PESO, SOLAPA_TAM, W / 2, SOLAPA_BASE, nombre="SOLAPA")
    qr = (f'<g id="qr"><path fill="#fff" d="{rect_redondeado(qx, qy, lado, lado, radio)}"/>'
          f'<g transform="translate({f(qx + QR_MARGEN)} {f(qy + QR_MARGEN)})">'
          f'<path id="qr-modulos" fill="{VERDE}" transform="scale(1)" d=""/>'
          f'<image id="qr-imagen" width="{f(lado - 2 * QR_MARGEN)}" height="{f(lado - 2 * QR_MARGEN)}" '
          f'href="" style="display:none"/></g></g>')
    partes = [f'<defs>{qr}<g id="cara">{cara}</g><path id="solapa" fill="{GUIA}" d="{solapa}"/></defs>',
              f'<rect width="210" height="297" fill="#fff"/>']
    for x0 in (0, W):
        partes += [
            f'<use href="#solapa" xlink:href="#solapa" transform="rotate(180 {f(x0 + W/2)} {f(M/2)}) translate({f(x0)} 0)"/>',
            f'<use href="#cara" xlink:href="#cara" transform="rotate(180 {f(x0 + W/2)} {f(M + CARA/2)}) translate({f(x0)} {M})"/>',
            f'<use href="#cara" xlink:href="#cara" transform="translate({f(x0)} {f(M + CARA)})"/>',
            f'<use href="#solapa" xlink:href="#solapa" transform="translate({f(x0)} {f(M + 2*CARA)})"/>',
        ]
    partes.append(f'<g fill="none" stroke-width="0.25"><path stroke="{GUIA}" stroke-dasharray="1.2 0.9" '
                  f'd="M0 {M}H210M0 {f(M + CARA)}H210M0 {f(M + 2*CARA)}H210"/>'
                  f'<path stroke="{CORTE}" d="M105 0V297"/></g>')
    return ('<svg class="hoja-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'width="210mm" height="297mm" viewBox="0 0 210 297">' + "".join(partes) + "</svg>")


def main():
    malos = [c for c in SUB_DEFECTO if c.upper() not in GLIFOS]
    if malos or len(SUB_DEFECTO) > SUB_MAX:
        sys.exit(f"Error: SUB_DEFECTO {SUB_DEFECTO!r} tiene caracteres no permitidos {malos} "
                 f"o supera el máximo de {SUB_MAX}.")
    sub_json = json.dumps({"glifos": GLIFOS, "kern": KERN, "max": SUB_MAX, "escala": SUB_ESCALA,
                           "espaciado": SUB_ESPACIADO, "x": SUB_X, "base": SUB_BASE,
                           "defecto": SUB_DEFECTO, "emoji": {"lado": EMOJI_LADO, "arriba": EMOJI_ARRIBA,
                           "carpeta": "emojis"}}, ensure_ascii=False, separators=(",", ":"))
    html = (AQUI / "plantilla.html").read_text(encoding="utf-8")
    reemplazos = {
        "__HOJA__": armar_hoja(),
        "__SUB_MAX__": str(SUB_MAX),
        "__SUB_DEFECTO__": SUB_DEFECTO,
        "__QR_DEFECTO__": QR_DEFECTO.replace("&", "&amp;").replace('"', "&quot;"),
        "__SUB_JSON__": sub_json,
        "__QRLIB__": (AQUI / "lib/qrcode.js").read_text(encoding="utf-8").strip(),
    }
    for marca, valor in reemplazos.items():
        if marca not in html:
            sys.exit(f"Error: plantilla.html no tiene la marca {marca}.")
        html = html.replace(marca, valor)
    SALIDA.write_text(html, encoding="utf-8")
    print(f"Página generada: {SALIDA}")
    print(f"Texto debajo del QR: máximo {SUB_MAX} caracteres.")


if __name__ == "__main__":
    main()
