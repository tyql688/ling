import { z } from "zod";
import { skinManifestSchema, SKIN_MANIFEST_FILE } from "./skins";

export function editorJsonSchemas() {
	return [
		{
			uri: "ling://schemas/skin",
			fileMatch: [`*/${SKIN_MANIFEST_FILE}`],
			schema: z.toJSONSchema(skinManifestSchema, { unrepresentable: "any" }),
		},
	];
}
