// Codemod review fixture: imports without semicolons, and a handler that assigns a style.
import * as React from "react"
import { cssVar } from "@codecaine-ai/design-system"

export const Chip = () => <span style={{ background: "#ebebe9" }} />
export const Hover = () => <div onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = "#ebebe9" }} />
