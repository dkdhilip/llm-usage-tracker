import { Link } from "react-router-dom";
import { buttonClass } from "../components/ui/Button";
import { PageHeader } from "../components/ui/PageHeader";

/** Shown for an address the app has no page for, instead of quietly landing on the dashboard (a typo or an old link
 *  used to look like it had worked). The way back is a link to the dashboard, which asks a visitor who is signed out to
 *  sign in first. */
export function NotFound() {
  return (
    <div>
      <PageHeader title="Page not found" description="There is no page at this address. The link may be mistyped, or the page may have moved." />
      <Link to="/dashboard" className={buttonClass("primary", "md")}>
        Go to the dashboard
      </Link>
    </div>
  );
}
