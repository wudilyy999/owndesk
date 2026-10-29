// noVNC 1.7 exports its ESM root; DefinitelyTyped still names the pre-1.7 path.
declare module "@novnc/novnc" {
  export { default } from "@novnc/novnc/lib/rfb"
}
