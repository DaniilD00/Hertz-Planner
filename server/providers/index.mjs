// Every site the map reads from. Add a new one by writing an adapter with { id, name, site, fetch(ctx) }
// that returns { stations, offers, unplaced } in the common format (see hertz.mjs).

import { drive4free } from './drive4free.mjs';
import { driveback } from './driveback.mjs';
import { hertz } from './hertz.mjs';

export const PROVIDERS = [hertz, driveback, drive4free];
