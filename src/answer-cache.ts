/** The visibility settings an answer was built for. Part of every key. */
export interface AnswerSettings {
  isHidden: boolean;
  hasChecks: boolean;
}

/** One cached answer and the inputs it was built from. */
export interface AnswerEntry<A, D> {
  answer: Promise<A>;
  /** Null while the build runs; afterwards every input the build read. */
  deps: readonly D[] | null;
}

/** What a build returns: the answer and the inputs it actually read. */
export interface BuiltAnswer<A, D> {
  answer: A;
  deps: readonly D[];
}

export interface AnswerLookup<A, D> {
  /** Builds the answer from fresh or cached reads. */
  build: () => Promise<BuiltAnswer<A, D>>;
  /** Whether one input is still current at `now`. */
  isValid: (dep: D, now: number) => boolean;
  now: () => number;
}

/** The cache key of an answer: settings, path and query. */
export function answerKey(settings: AnswerSettings, pathname: string, search: string): string {
  return `${settings.isHidden ? 1 : 0}${settings.hasChecks ? 1 : 0}:${pathname}${search}`;
}

function isReusable<A, D>(entry: AnswerEntry<A, D>, lookup: AnswerLookup<A, D>): boolean {
  // An entry in flight is joined, so two builds for one key never run at once.
  if (entry.deps === null) return true;
  const now = lookup.now();
  return entry.deps.every((dep) => lookup.isValid(dep, now));
}

/**
 * The answer for `key`: the cached one while every input is still valid, else a new build.
 * A finished build stores its inputs only if its entry is still in the map. A rejected build
 * is removed before the caller sees the rejection, so it is never reused.
 */
export function cachedAnswerFor<A, D>(
  answers: Map<string, AnswerEntry<A, D>>,
  key: string,
  lookup: AnswerLookup<A, D>,
): Promise<A> {
  const found = answers.get(key);
  if (found !== undefined && isReusable(found, lookup)) return found.answer;
  const settle = async (): Promise<A> => {
    try {
      // The build starts after the entry is in the map, also if it throws at once.
      const built = await Promise.resolve().then(() => lookup.build());
      if (answers.get(key) === entry) entry.deps = built.deps;
      return built.answer;
    } catch (err) {
      if (answers.get(key) === entry) answers.delete(key);
      throw err;
    }
  };
  const entry: AnswerEntry<A, D> = { answer: settle(), deps: null };
  answers.set(key, entry);
  return entry.answer;
}
