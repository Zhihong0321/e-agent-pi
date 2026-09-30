import * as Type from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/typebox.mjs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { requestShareFile } from "../../server/share-file-cli.mjs";

export default function shareFileExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "share_file",
    label: "Share file",
    description: "Publish a completed file from this agent's workspace and return its persistent browser link. Use for any file intended for the user. Existing shared URLs need no republishing.",
    parameters: Type.Object({ path: Type.String({ description: "Path to the completed file inside this workspace" }) }),
    async execute(_id, args, signal) {
      const result = await requestShareFile(args.path, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
