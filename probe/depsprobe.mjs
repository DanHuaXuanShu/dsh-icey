import { loadHostDeps, candidateRoots } from "../lib/hostdeps.mjs";
const r = await loadHostDeps();
console.log("z:", r.z ? (typeof r.z === "function" ? "ok-fn" : "ok-obj") : "NULL");
console.log("defineTool local-fallback:", r.defineTool.name || "anonymous");
console.log("notes:\n  " + r.notes.join("\n  "));
console.log("roots:", JSON.stringify(candidateRoots(), null, 1));
