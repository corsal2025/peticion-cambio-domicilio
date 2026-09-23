// App Hono: monta todos los routers bajo /api. Rutas publicas (login/logout/me)
// se registran ANTES del guard; el resto exige sesion valida; config/usuarios/
// mail-prueba ademas exigen rol admin. import y relay tienen su propia
// autenticacion por secreto compartido y se montan fuera del guard de sesion.
import { Hono } from 'hono';
import { guard, soloAdmin, authRoutes } from './routes/auth.js';
import { peticionesRoutes } from './routes/peticiones.js';
import { comunasRoutes } from './routes/comunas.js';
import { importarRoutes } from './routes/importar.js';
import { comunasSyncRoutes } from './routes/comunasSync.js';
import { relayRoutes } from './routes/relay.js';
import { configRoutes } from './routes/config.js';
import { estadisticasRoutes } from './routes/estadisticas.js';
import { usuariosRoutes } from './routes/usuarios.js';
import { enviosRoutes } from './routes/envios.js';

export const app = new Hono();

const api = new Hono();

// Autenticadas por secreto compartido, NUNCA por cookie de sesion: Apps Script
// y el proceso --relay no tienen navegador.
api.route('/', importarRoutes);
api.route('/', comunasSyncRoutes);
api.route('/', relayRoutes);

// Publicas (login/logout/me).
api.route('/', authRoutes);

// A partir de aqui, toda ruta /api/* exige sesion valida.
api.use('*', guard);

api.route('/', peticionesRoutes);
api.route('/', comunasRoutes);
api.route('/', estadisticasRoutes);

// Solo admin.
const admin = new Hono();
admin.use('*', soloAdmin);
admin.route('/', configRoutes);
admin.route('/', usuariosRoutes);
admin.route('/', enviosRoutes);
api.route('/', admin);

app.route('/api', api);

app.onError((err, c) => {
  if (!err.status || err.status >= 500) console.error(err);
  return c.json({ error: err.message || 'Error interno' }, err.status || 500);
});

export default app;
