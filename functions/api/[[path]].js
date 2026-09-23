import { handle } from 'hono/cloudflare-pages';
import { app } from '../../worker/app.js';

export const onRequest = handle(app);
