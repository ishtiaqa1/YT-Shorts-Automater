/**
 * ES modules evaluate all static imports before the importer's body runs, so `.env`
 * must load in its own imported module listed first in `index.js` — otherwise `db.js`
 * builds the Pool with `DATABASE_URL` still unset.
 */
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });
