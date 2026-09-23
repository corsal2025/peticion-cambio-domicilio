// Boton "mostrar/ocultar clave" (👁) reutilizable en login, alta de usuario,
// restablecer clave y cambio de clave propia. La logica (que tipo toca poner,
// que texto/aria-label/aria-pressed corresponde) esta separada en funciones
// puras sin DOM para poder testearla con `node --test` (no hay jsdom en este
// proyecto); `montarToggleClave` es el unico pedazo que toca el DOM, y es
// deliberadamente delgado.

/** Alterna entre 'password' (clave oculta) y 'text' (clave visible). */
export function alternarTipoClave(tipoActual) {
  return tipoActual === 'password' ? 'text' : 'password';
}

/** Atributos accesibles del boton segun el `type` actual del input que controla. */
export function atributosToggleClave(tipoActual) {
  const oculta = tipoActual !== 'text';
  return {
    texto: oculta ? '👁' : '🙈',
    ariaLabel: oculta ? 'Mostrar clave' : 'Ocultar clave',
    ariaPressed: oculta ? 'false' : 'true',
  };
}

/**
 * Conecta un boton (debe ser type="button", ya creado en el DOM) con un
 * input de clave: al hacer click alterna el `type` del input y refresca
 * texto/aria-label/aria-pressed del boton.
 */
export function montarToggleClave(input, boton) {
  const aplicar = () => {
    const attrs = atributosToggleClave(input.type);
    boton.textContent = attrs.texto;
    boton.setAttribute('aria-label', attrs.ariaLabel);
    boton.setAttribute('aria-pressed', attrs.ariaPressed);
  };
  boton.addEventListener('click', () => {
    input.type = alternarTipoClave(input.type);
    aplicar();
  });
  aplicar();
}
