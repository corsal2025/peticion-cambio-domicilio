/**
 * Plantilla para apps-script/Config.gs (gitignorado).
 *
 * Copiar este archivo a "Config.gs" en la misma carpeta y completar los
 * valores reales. `clasp push` sube Config.gs junto con el resto del
 * proyecto (Code.gs, appsscript.json) sin que el secret quede comiteado en
 * el repo. Despues de cada `clasp push`, correr `configurar()` una vez desde
 * el editor de Apps Script para volcar estos valores a Script Properties.
 *
 * apps-script/.claspignore excluye este archivo (Config.example.gs) del
 * push, asi que en el editor de Apps Script solo debe existir Config.gs.
 */
function CONFIG_() {
  return {
    WORKER_URL: 'https://peticion-cambio-domicilio.pages.dev',
    IMPORT_SECRET: 'REEMPLAZAR-CON-EL-SECRET-DEL-WORKER',
    XLSX_FILE_ID: 'REEMPLAZAR-CON-EL-ID-DEL-ARCHIVO-XLSX-EN-DRIVE',
  };
}
