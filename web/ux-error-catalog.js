// UX Error Catalog — shared across feria-unq pages.
// Add new entries here so every user-facing error has a consistent
// {action, rootCode, title, description, actionHint} shape.
(function () {
  "use strict";

  const catalog = [
    // Generic fallback — must exist.
    {
      action: "*",
      rootCode: "*",
      title: "Error inesperado",
      description: "Ocurrió un problema que no esperábamos.",
      actionHint: "Intentá recargar la página. Si persiste, contactá a soporte.",
    },

    // Runtime / network errors captured automatically.
    {
      action: "js-runtime",
      rootCode: "UNCAUGHT_EXCEPTION",
      title: "Error interno",
      description: "La aplicación encontró un error inesperado.",
      actionHint: "Recargá la página. Si persiste, contactá a soporte.",
    },
    {
      action: "js-runtime",
      rootCode: "UNHANDLED_REJECTION",
      title: "Error interno",
      description: "La aplicación encontró un error inesperado.",
      actionHint: "Recargá la página. Si persiste, contactá a soporte.",
    },
    {
      action: "resource",
      rootCode: "LOAD_ERROR",
      title: "No se pudo cargar un recurso",
      description: "Una imagen, script u otro recurso no pudo cargarse.",
      actionHint: "Revisá tu conexión y recargá la página.",
    },
    {
      action: "network",
      rootCode: "FETCH_FAILED",
      title: "Error de red",
      description: "No se pudo completar la solicitud al servidor.",
      actionHint: "Revisá tu conexión a internet.",
    },
    {
      action: "network",
      rootCode: "WS_ERROR",
      title: "Error en actualizaciones en vivo",
      description: "La conexión de actualizaciones en vivo falló.",
      actionHint: "La app intentará reconectarse sola.",
    },
    {
      action: "network",
      rootCode: "WS_CLOSE",
      title: "Actualizaciones en vivo interrumpidas",
      description: "Se perdió la conexión de actualizaciones en vivo.",
      actionHint: "La app intentará reconectarse sola.",
    },

    // Authentication / login.
    {
      action: "login",
      rootCode: "MERCHANT_AUTH_401",
      title: "Acceso fallido",
      description: "El usuario o la contraseña no son válidos.",
      actionHint: "Verificá los datos de acceso.",
    },
    {
      action: "login",
      rootCode: "MERCHANT_AUTH_403",
      title: "Acceso denegado",
      description: "No tenés permisos para ingresar.",
      actionHint: "Contactá a soporte.",
    },
    {
      action: "login",
      rootCode: "BANK_AUTH_401",
      title: "Banco no autorizó",
      description: "Las credenciales fueron rechazadas por el banco.",
      actionHint: "Verificá usuario y contraseña.",
    },
    {
      action: "login",
      rootCode: "BANK_AUTH_403",
      title: "Banco denegó el acceso",
      description: "El banco no permite el acceso con estas credenciales.",
      actionHint: "Contactá a soporte.",
    },
    {
      action: "login",
      rootCode: "NETWORK",
      title: "Sin conexión",
      description: "No se pudo contactar al servidor de autenticación.",
      actionHint: "Revisá tu conexión a internet.",
    },
    {
      action: "session",
      rootCode: "EXPIRED",
      title: "Sesión expirada",
      description: "Tu sesión expiró o no está autorizada.",
      actionHint: "Volvé a iniciar sesión.",
    },

    // Productores / donde.html.
    {
      action: "load-productores",
      rootCode: "FETCH_404",
      title: "Listado no encontrado",
      description: "No se encontró el archivo de productorxs.",
      actionHint: "Recargá la página.",
    },
    {
      action: "load-productores",
      rootCode: "FETCH_500",
      title: "Error al cargar listado",
      description: "El servidor no pudo entregar el listado de productorxs.",
      actionHint: "Intentá de nuevo en unos segundos.",
    },
    {
      action: "share",
      rootCode: "CLIPBOARD",
      title: "No se pudo copiar",
      description: "El navegador no permitió copiar el enlace.",
      actionHint: "Copiá el enlace manualmente.",
    },
    {
      action: "share",
      rootCode: "NOT_SUPPORTED",
      title: "Compartir no disponible",
      description: "Tu navegador no permite compartir desde aquí.",
      actionHint: "Copiá el enlace manualmente.",
    },

    // Merchant operations.
    {
      action: "withdraw",
      rootCode: "FETCH_400",
      title: "Datos inválidos",
      description: "El monto ingresado no es válido.",
      actionHint: "Ingresá un monto mayor a 0 y menor al disponible.",
    },
    {
      action: "withdraw",
      rootCode: "FETCH_409",
      title: "Saldo insuficiente",
      description: "No tenés saldo disponible para retirar.",
      actionHint: "Verificá el monto ingresado.",
    },
    {
      action: "withdraw",
      rootCode: "FETCH_500",
      title: "Error al retirar",
      description: "El servidor no pudo crear el retiro.",
      actionHint: "Intentá de nuevo en unos segundos.",
    },
    {
      action: "withdraw",
      rootCode: "QR_GENERATION",
      title: "Error al generar el QR",
      description: "No se pudo generar el código QR de retiro.",
      actionHint: "Intentá de nuevo.",
    },
    {
      action: "withdraw",
      rootCode: "CONFIRM_FAILED",
      title: "No se pudo confirmar el retiro",
      description: "La confirmación del retiro falló.",
      actionHint: "Intentá de nuevo o cancelá la operación.",
    },
    {
      action: "transfer",
      rootCode: "FETCH_400",
      title: "Datos inválidos",
      description: "Los datos de la transferencia no son válidos.",
      actionHint: "Verificá el alias y el monto.",
    },
    {
      action: "transfer",
      rootCode: "FETCH_404",
      title: "Cuenta no encontrada",
      description: "La cuenta destino no existe o está restringida.",
      actionHint: "Verificá el alias ingresado.",
    },
    {
      action: "transfer",
      rootCode: "FETCH_409",
      title: "Saldo insuficiente",
      description: "No tenés saldo para realizar la transferencia.",
      actionHint: "Verificá el monto.",
    },
    {
      action: "transfer",
      rootCode: "FETCH_500",
      title: "Error al transferir",
      description: "El servidor no pudo crear la transferencia.",
      actionHint: "Intentá de nuevo en unos segundos.",
    },
    {
      action: "close-account",
      rootCode: "FETCH_400",
      title: "No se puede cerrar la caja",
      description: "La cuenta no tiene condiciones para cerrarse.",
      actionHint: "Verificá que tenga saldo o contactá a soporte.",
    },
    {
      action: "close-account",
      rootCode: "FETCH_500",
      title: "Error al cerrar caja",
      description: "No se pudo cerrar la cuenta.",
      actionHint: "Intentá de nuevo o contactá a soporte.",
    },
    {
      action: "change-password",
      rootCode: "FETCH_400",
      title: "Contraseña inválida",
      description: "La nueva contraseña no cumple los requisitos.",
      actionHint: "Revisá los requisitos de seguridad.",
    },
    {
      action: "change-password",
      rootCode: "FETCH_500",
      title: "Error al cambiar contraseña",
      description: "No se pudo actualizar la contraseña.",
      actionHint: "Intentá de nuevo.",
    },
    {
      action: "polling",
      rootCode: "FETCH_500",
      title: "Error al sincronizar datos",
      description: "No se pudieron obtener las últimas ordenes o transacciones.",
      actionHint: "Revisá tu conexión. La app reintentará sola.",
    },
    {
      action: "polling",
      rootCode: "FETCH_502",
      title: "Servidor upstream no respondió",
      description: "El servidor intermedio no pudo contactar al banco o comercio.",
      actionHint: "Revisá tu conexión. La app reintentará sola.",
    },
    {
      action: "no-funds",
      rootCode: "BALANCE_ZERO",
      title: "Sin fondos",
      description: "No tenés saldo disponible para esta operación.",
      actionHint: "Esperá a tener una venta o recibir una transferencia.",
    },
  ];

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.UXErrorCatalog = {
    find(action, rootCode) {
      const exact = catalog.find(
        (e) => e.action === action && e.rootCode === rootCode
      );
      if (exact) return exact;
      const actionDefault = catalog.find(
        (e) => e.action === action && e.rootCode === "*"
      );
      if (actionDefault) return actionDefault;
      return catalog.find((e) => e.action === "*" && e.rootCode === "*");
    },

    add(entries) {
      if (Array.isArray(entries)) catalog.push(...entries);
      else catalog.push(entries);
    },

    show(action, rootCode, extraMessage) {
      const entry = this.find(action, rootCode);
      const detail = {
        ...entry,
        action,
        rootCode,
        extraMessage: extraMessage || "",
      };
      window.dispatchEvent(new CustomEvent("ux-error", { detail }));
      if (window.UXMetrics && window.UXMetrics.showErrorToast) {
        window.UXMetrics.showErrorToast(detail);
      }
      return detail;
    },

    escapeHtml,
  };
})();
