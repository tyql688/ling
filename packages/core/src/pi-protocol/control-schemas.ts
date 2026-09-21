import { z } from "zod";
import { absolutePathSchema, nativeSessionRefSchema } from "../paths";

/** Control identities retain their framing bound, independently of transcript IDs. */
export const controlIdSchema = z.string().min(1).max(160);
export const controlSessionRefSchema = nativeSessionRefSchema.extend({ sessionId: controlIdSchema });
export const controlPathSchema = absolutePathSchema("Pi worker path");
