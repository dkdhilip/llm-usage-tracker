/** Where floating content (a menu, a popover list) is drawn: inside the page's <main>, not at the end of <body>, so it
 *  stays within a landmark and a screen reader does not find it floating outside the page. Falls back to <body>. */
export const pageContainer = () => (typeof document === "undefined" ? null : document.getElementById("main"));
