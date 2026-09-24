// Plantilla del correo de solicitud de cambio de domicilio. Port 1:1 de
// PeticionCambioDomicilio.Domain.EmailTemplate: cita el articulo 14 del
// Decreto 170 (MTT), un correo por comuna, agrupando todas las personas
// cuyas carpetas se piden a esa municipalidad.

const ASUNTO_FIJO = 'Solicitud de cambio de domicilio';

/** Agrupa peticiones (marcadas y pendientes) por comuna destino, un grupo = un correo. */
export function agruparPorComuna(peticiones) {
  const mapa = new Map();
  for (const p of peticiones) {
    if (!mapa.has(p.comuna)) {
      mapa.set(p.comuna, []);
    }
    mapa.get(p.comuna).push(p);
  }
  return Array.from(mapa.entries()).map(([comuna, lista]) => ({ comuna, peticiones: lista }));
}

function claseSufijo(p) {
  return p.clases && p.clases.trim() !== '' ? ` — Clase ${p.clases}` : '';
}

/**
 * Construye el correo (asunto fijo + cuerpo en texto plano) para una comuna,
 * con una o varias personas.
 */
export function construirCorreo(peticiones, firmaCorreo = '') {
  if (!peticiones || peticiones.length === 0) {
    throw new Error('El correo necesita al menos una peticion.');
  }

  const varias = peticiones.length > 1;
  const sujeto = varias
    ? 'las carpetas con los antecedentes de los siguientes conductores'
    : 'la carpeta con los antecedentes del siguiente conductor';

  const lines = [
    'Estimados,',
    '',
    'Junto con saludar, y conforme a lo establecido en el artículo 14 del Decreto N.º 170 del ' +
      'Ministerio de Transportes y Telecomunicaciones, "Reglamento para el Otorgamiento de ' +
      `Licencias de Conducir", solicito a ustedes tengan a bien hacer llegar, a través de la ` +
      `Plataforma SGL, ${sujeto}, para la correspondiente emisión de su licencia de conducir:`,
    '',
  ];

  if (varias) {
    peticiones.forEach((p, i) => {
      lines.push(`${i + 1}. Nombre: ${p.nombreCompleto} — RUT: ${p.rut}${claseSufijo(p)}`);
    });
  } else {
    const p = peticiones[0];
    lines.push(`Nombre: ${p.nombreCompleto}`);
    lines.push(`RUT: ${p.rut}${claseSufijo(p)}`);
  }

  lines.push('', 'Quedamos atentos a su respuesta.', '', 'Saludos cordiales,', 'Departamento de Licencias de Conducir', 'Municipalidad de Valparaíso', firmaCorreo);

  return { asunto: ASUNTO_FIJO, cuerpo: lines.join('\n') };
}
