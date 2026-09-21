import type * as ParcelWatcher from "@parcel/watcher";
import { createRequire } from "node:module";

const watcher = createRequire(import.meta.url)("@parcel/watcher") as typeof ParcelWatcher;

export const subscribe = watcher.subscribe;
