import { createPiSettingsUpdateSchema } from "@ling/contracts/pi-settings-requests";
import { isAbsolute } from "node:path";
import { isTildePath } from "../paths";
export const piSettingsUpdateSchema = createPiSettingsUpdateSchema((value) => isAbsolute(value) || isTildePath(value));
