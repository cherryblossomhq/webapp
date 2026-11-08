import { createElement, memo, useMemo } from "react"
import type { TitleBlock } from "../../model/paper"
import type { SheetPaper } from "../../model/types"
import { useSch } from "../theme"
import { paintOutside, paintPage } from "./pagePaint"

/** The sheet's page under everything else: the tint outside it, the border and the title block. Memoised on its props, so a drag that changes neither doesn't redraw it. */
export const PageView = memo(function PageView({ page, px }: { page: { paper: SheetPaper; block: TitleBlock }; px: number }) {
  const sch = useSch()
  const nodes = useMemo(() => [paintOutside(page.paper, sch), ...paintPage(page.paper, page.block, sch, px)], [page, sch, px])
  return <g className="pointer-events-none">{nodes.map((node, i) => createElement(node.tag, { key: i, ...node.attrs }, node.text))}</g>
})
