// Transporte SOAP minimo contra EWS on-premises de Exchange (modo `direct`).
// Port 1:1 de PeticionCambioDomicilio.Ews.EwsMailSender/EwsRetryPolicy: reintenta
// SOLO fallos transitorios (backoff 2/4/8/16s, max 4 intentos) y corta de
// inmediato en 401/403 para no acelerar el bloqueo de la cuenta de dominio.
// `fetchImpl`/`sleep` son inyectables para poder testear sin red ni timers reales.

const MAX_INTENTOS = 4;

/** Clasifica un status HTTP de EWS: 'accept' | 'retry' | 'failAuth' | 'failPermanent'. */
export function classify(status) {
  if (status >= 200 && status < 300) return 'accept';
  if (status === 401 || status === 403) return 'failAuth';
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return 'retry';
  return 'failPermanent';
}

/** Arma el SOAP CreateItem (SendAndSaveCopy) para un correo de texto plano. */
export function buildSendMailRequest(toAddress, subject, body, sendAsAddress) {
  const from = sendAsAddress
    ? `<t:From><t:Mailbox><t:EmailAddress>${escapeXml(sendAsAddress)}</t:EmailAddress></t:Mailbox></t:From>`
    : '';
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
    'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ' +
    'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">' +
    '<soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>' +
    '<soap:Body><m:CreateItem MessageDisposition="SendAndSaveCopy">' +
    '<m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId>' +
    '<m:Items><t:Message>' +
    `<t:Subject>${escapeXml(subject)}</t:Subject>` +
    `<t:Body BodyType="Text">${escapeXml(body)}</t:Body>` +
    `<t:ToRecipients><t:Mailbox><t:EmailAddress>${escapeXml(toAddress)}</t:EmailAddress></t:Mailbox></t:ToRecipients>` +
    from +
    '</t:Message></m:Items></m:CreateItem></soap:Body></soap:Envelope>'
  );
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sleepReal(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Envia un correo via EWS SOAP. Lanza Error en caso de fallo (mensaje describe la causa).
 * @param {{url:string, usuario:string, clave:string, sendAs?:string}} opciones
 * @param {{to:string, subject:string, body:string}} correo
 * @param {{fetchImpl?:Function, sleep?:Function}} [deps]
 */
export async function enviarEws(opciones, correo, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? sleepReal;

  if (!opciones?.url || !opciones?.usuario || !opciones?.clave) {
    throw new Error('Falta configurar EWS (url/usuario/clave).');
  }

  const soap = buildSendMailRequest(correo.to, correo.subject, correo.body, opciones.sendAs);
  const credenciales = btoa(`${opciones.usuario}:${opciones.clave}`);

  let intento = 0;
  let delay = 2000;

  while (true) {
    intento++;
    let respuesta;
    try {
      respuesta = await fetchImpl(opciones.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', Authorization: `Basic ${credenciales}` },
        body: soap,
      });
    } catch (err) {
      if (intento < MAX_INTENTOS) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new Error(`No se pudo alcanzar Exchange tras ${MAX_INTENTOS} intentos: ${err.message}`);
    }

    const accion = classify(respuesta.status);
    if (accion === 'accept') {
      return;
    }
    if (accion === 'failAuth') {
      throw new Error(`Exchange rechazo las credenciales (HTTP ${respuesta.status}).`);
    }
    if (accion === 'retry') {
      if (intento < MAX_INTENTOS) {
        await sleep(delay);
        delay *= 2;
        continue;
      }
      throw new Error(`Exchange no respondio tras ${MAX_INTENTOS} intentos (ultimo: HTTP ${respuesta.status}).`);
    }
    throw new Error(`Exchange devolvio HTTP ${respuesta.status}.`);
  }
}
