import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { withQuery } from "@/hooks/use-router";

export type DealsView = "board" | "next-steps";

/** The deals page's two lenses on the same deals: the pipeline board, and open deals by what needs attention. */
export function DealsViewSwitch({ view, navigate }: { view: DealsView; navigate: (to: string) => void }) {
  return (
    <Tabs value={view} onValueChange={(v) => navigate(withQuery({ view: v === "board" ? null : v, record: null }))}>
      <TabsList aria-label="Deals view">
        <TabsTrigger value="board">Board</TabsTrigger>
        <TabsTrigger value="next-steps">Next steps</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
