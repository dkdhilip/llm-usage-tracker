/** The username rule the server enforces (backend/app/routers/auth.py): 3-32 characters, letters, digits and
 *  . _ - only, starting and ending with a letter or digit.
 *
 *  Browsers compile an input's `pattern` with the `v` flag, where a bare "-" at the end of a character class is a
 *  syntax error (the whole pattern is then ignored, with a console error). So the "-" is escaped here, which is
 *  valid with and without that flag. */
export const USERNAME_PATTERN = String.raw`[A-Za-z0-9][A-Za-z0-9._\-]{1,30}[A-Za-z0-9]`;

export const USERNAME_RULES = "3-32 characters: letters, digits, . _ - (must start and end with a letter or digit)";
