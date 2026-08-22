import type { ArtifactBuildRuntimeImplementation } from "./artifact-adapter-contract.js";

export const REACT_SOURCE_BUILD_RUNTIME: ArtifactBuildRuntimeImplementation = Object.freeze({
  id: "studio.react-source",
  version: "1",
  module: { kind: "source" },
} satisfies ArtifactBuildRuntimeImplementation);

export const SVG_REACT_BUILD_RUNTIME: ArtifactBuildRuntimeImplementation = Object.freeze({
  id: "studio.svg-react",
  version: "1",
  module: {
    kind: "virtual",
    sourceLoader: "text",
    runtimePackages: [],
    source: [
      'import React from "react";',
      'import source from "artifact-source";',
      "let resolveReady;let rejectReady;",
      "export const artifactReady=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});",
      "export default function SvgArtifact(){",
      "const [uri]=React.useState(()=>URL.createObjectURL(new Blob([source],{type:'image/svg+xml'})));",
      "React.useEffect(()=>()=>URL.revokeObjectURL(uri),[uri]);",
      "return React.createElement('div',{style:{display:'grid',placeItems:'center',minHeight:'100vh',padding:'16px'}},",
      "React.createElement('img',{src:uri,alt:'SVG artifact',style:{maxWidth:'100%',height:'auto'},onLoad:()=>resolveReady(),onError:()=>rejectReady(new Error('SVG image could not be decoded.'))}));",
      "}",
    ].join("\n"),
  },
} satisfies ArtifactBuildRuntimeImplementation);

export const MERMAID_REACT_BUILD_RUNTIME: ArtifactBuildRuntimeImplementation = Object.freeze({
  id: "studio.mermaid-react",
  version: "1",
  module: {
    kind: "virtual",
    sourceLoader: "text",
    runtimePackages: ["beautiful-mermaid"],
    minify: true,
    source: [
      'import React from "react";',
      'import {renderMermaidSVG} from "beautiful-mermaid";',
      'import source from "artifact-source";',
      "let resolveReady;let rejectReady;",
      "export const artifactReady=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});",
      "export default function MermaidArtifact(context){",
      "const svg=React.useMemo(()=>renderMermaidSVG(source,{bg:context.theme==='dark'?'#101319':'#ffffff',fg:context.theme==='dark'?'#e8ecf3':'#1b2430',font:'system-ui',transparent:true}).split('\\n').filter((line)=>!line.trim().startsWith('@import ')).join('\\n'),[]);",
      "const [uri]=React.useState(()=>URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'})));",
      "React.useEffect(()=>()=>URL.revokeObjectURL(uri),[uri]);",
      "return React.createElement('div',{style:{display:'grid',placeItems:'center',minHeight:'100vh',padding:'16px'}},",
      "React.createElement('img',{src:uri,alt:'Mermaid diagram',style:{maxWidth:'100%',height:'auto'},onLoad:()=>resolveReady(),onError:()=>rejectReady(new Error('Mermaid SVG could not be decoded.'))}));",
      "}",
    ].join("\n"),
  },
} satisfies ArtifactBuildRuntimeImplementation);
