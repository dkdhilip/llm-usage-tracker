import { Badge } from "../../components/ui/Badge";
import { InlineAlert } from "../../components/ui/InlineAlert";

// a badge does not wrap by default; these are sentences, and must on a narrow screen
const WRAP = "!h-auto !whitespace-normal py-0.5";

/** Said before Send, not after: this is not a sandbox. It also explains the two kinds of cost shown on a response, so
 *  "Estimated" and "Actual charge" mean something when they appear. */
export function CostWarning() {
  return (
    <InlineAlert tone="warning" role="note" title="This sends a real request and costs money">
      <p>It calls the provider with your workspace's key and is billed to that account.</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge variant="success" className={WRAP}>
          OpenRouter: actual provider charge
        </Badge>
        <Badge className={WRAP}>OpenAI, Anthropic, Gemini: estimated from our price table</Badge>
      </div>
    </InlineAlert>
  );
}
