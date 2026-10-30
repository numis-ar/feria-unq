#!/usr/bin/env python3
"""
preparar-emojis.py — Arma la carpeta ../emojis/ con los emojis de Twemoji, listos
para que la página y generar-cartel.py los usen bajo demanda.

Hace tres cosas:
  1. Copia cada SVG de Twemoji pasando <circle> y <ellipse> a curvas explícitas
     (así el navegador y WeasyPrint los dibujan exactamente igual).
  2. Arma ../emojis/indice.js: qué emojis hay (secuencia → archivo) y los shortcodes
     (:grinning:, :athletic_shoe:, ... y sus equivalentes en castellano).
  3. Copia las licencias.

Uso (normalmente no hace falta: la carpeta emojis/ ya viene armada):
    python3 preparar-emojis.py --twemoji CARPETA_CON_LOS_SVG

  --twemoji    carpeta con los SVG originales (paquete npm @twemoji/svg). Por
               defecto usa ../emojis (re-procesa lo que ya está; es idempotente).
  --shortcodes uno o más JSON de shortcodes de emojibase-data (por defecto, los
               de datos/: github.json en inglés y cldr-es.json en castellano).
               Si dos fuentes usan el mismo nombre, gana la primera.

Requisitos: solo Python 3. No usa la red.
"""
import argparse
import json
import math
import re
import shutil
import sys
from pathlib import Path

AQUI = Path(__file__).resolve().parent
DESTINO = AQUI.parent / "emojis"
VS16 = "️"      # selector de variación "emoji": se ignora para buscar
K = 0.5522847498     # constante para aproximar un cuarto de círculo con una Bézier


def num(v):
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def elipse_a_path(cx, cy, rx, ry):
    kx, ky = rx * K, ry * K
    return (f"M{num(cx + rx)} {num(cy)}"
            f"C{num(cx + rx)} {num(cy + ky)} {num(cx + kx)} {num(cy + ry)} {num(cx)} {num(cy + ry)}"
            f"C{num(cx - kx)} {num(cy + ry)} {num(cx - rx)} {num(cy + ky)} {num(cx - rx)} {num(cy)}"
            f"C{num(cx - rx)} {num(cy - ky)} {num(cx - kx)} {num(cy - ry)} {num(cx)} {num(cy - ry)}"
            f"C{num(cx + kx)} {num(cy - ry)} {num(cx + rx)} {num(cy - ky)} {num(cx + rx)} {num(cy)}Z")


def convertir(svg):
    def reemplazo(m):
        etiqueta, attrs, cierre = m.group(1), m.group(2), m.group(3)
        a = dict(re.findall(r'([\w:-]+)="([^"]*)"', attrs))
        cx, cy = float(a.pop("cx", 0)), float(a.pop("cy", 0))
        if etiqueta == "circle":
            rx = ry = float(a.pop("r"))
        else:
            rx, ry = float(a.pop("rx")), float(a.pop("ry"))
        resto = "".join(f' {k}="{v}"' for k, v in a.items())
        return f'<path{resto} d="{elipse_a_path(cx, cy, rx, ry)}"{cierre}'
    svg = re.sub(r"<(circle|ellipse)((?:\s+[\w:-]+=\"[^\"]*\")*)\s*(/>|>\s*</\1>)",
                 lambda m: reemplazo(m).replace(f"></{m.group(1)}>", "/>"), svg)
    if re.search(r"<(circle|ellipse)\b", svg):
        raise ValueError("quedó un <circle>/<ellipse> sin convertir")
    return svg


def secuencia(nombre_archivo):
    """'1f3c3-1f3fb-200d-2640-fe0f' → texto sin selectores de variación."""
    return "".join(chr(int(h, 16)) for h in nombre_archivo.split("-") if h.lower() != "fe0f")


def main():
    ap = argparse.ArgumentParser(description="Prepara la carpeta emojis/ (Twemoji + shortcodes).")
    ap.add_argument("--twemoji", default=str(DESTINO), help="Carpeta con los SVG de Twemoji")
    ap.add_argument("--shortcodes", nargs="+",
                    default=[str(AQUI / "datos/github.json"), str(AQUI / "datos/cldr-es.json")])
    args = ap.parse_args()

    origen = Path(args.twemoji).resolve()
    svgs = sorted(origen.glob("*.svg"))
    if not svgs:
        sys.exit(f"Error: no hay archivos .svg en {origen}")
    DESTINO.mkdir(exist_ok=True)

    archivos = {}
    for p in svgs:
        clave = secuencia(p.stem)
        if clave in archivos:
            sys.exit(f"Error: {p.name} y {archivos[clave]}.svg son el mismo emoji")
        archivos[clave] = p.stem
        texto = convertir(p.read_text(encoding="utf-8"))
        (DESTINO / p.name).write_text(texto, encoding="utf-8")

    shortcodes, sin_emoji = {}, 0
    for fuente in args.shortcodes:
        datos = json.loads(Path(fuente).read_text(encoding="utf-8"))
        for hexa, nombres in datos.items():
            clave = secuencia(hexa)
            if clave not in archivos:
                sin_emoji += 1
                continue
            for n in ([nombres] if isinstance(nombres, str) else nombres):
                n = n.lower()
                if re.fullmatch(r"[a-z0-9_+\-]+", n) and n not in shortcodes:
                    shortcodes[n] = clave

    indice = {"origen": "Twemoji", "archivos": archivos, "shortcodes": shortcodes}
    js = ("// GENERADO por regenerar/preparar-emojis.py — no editar a mano.\n"
          "// Emojis de Twemoji (gráficos CC-BY 4.0) y shortcodes de emojibase-data (MIT).\n"
          "window.TWEMOJI = " + json.dumps(indice, ensure_ascii=False, separators=(",", ":")) + ";\n")
    (DESTINO / "indice.js").write_text(js, encoding="utf-8")
    for lic in AQUI.glob("datos/LICENCIA*.txt"):
        shutil.copy(lic, DESTINO / lic.name)

    print(f"Emojis: {len(archivos)} · shortcodes: {len(shortcodes)} "
          f"({sin_emoji} entradas de shortcodes sin emoji en Twemoji, ignoradas)")
    print(f"Carpeta: {DESTINO}")


if __name__ == "__main__":
    main()
