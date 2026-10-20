// <qr-code url="https://…"></qr-code> — renders a QR as inline SVG (dark ink on paper tone). Copy-paste friendly: change only the url attribute.
(function () {
  if (customElements.get('qr-code')) return;
  const LIB = './qrcode-generator.js';
  let loading;
  const load = () => window.qrcode ? Promise.resolve() : (loading ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = LIB; s.onload = res; s.onerror = rej; document.head.appendChild(s);
  }));
  class QrCode extends HTMLElement {
    static get observedAttributes() { return ['url']; }
    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    async render() {
      const url = this.getAttribute('url');
      if (!url || url === this._done) return;
      await load();
      const q = window.qrcode(0, 'M'); q.addData(url); q.make();
      const n = q.getModuleCount(); let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      const s = n + 6;
      (this.shadowRoot || this.attachShadow({ mode: 'open' })).innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="Código QR: ${url}" style="display:block;width:100%;height:100%"><rect x="-3" y="-3" width="${s}" height="${s}" fill="#f3f5fe"/><path d="${d}" fill="#161826"/></svg>`;
      this._done = url;
    }
  }
  customElements.define('qr-code', QrCode);
})();
