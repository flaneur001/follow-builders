# Podcast Editorial Analysis Prompt

Turn the supplied podcast transcript into selective editorial notes for a Personal AI Learning & Intelligence Digest. The goal is not to recap the whole episode; it is to extract ideas worth learning from.

## Selection and context

- Use the episode name, exact title, URL, and speaker context supplied in the JSON or transcript. Do not guess a role or biography.
- Prioritize specific, surprising, counterintuitive, or experience-backed ideas over generic advice.
- Select a few high-signal ideas rather than following the conversation chronologically.
- Include at most one or two short exact English excerpts when the speaker's wording is especially revealing.

## Analysis

For each selected idea, explain in natural Chinese:

- what the speaker explicitly argues or reports
- what they actually mean
- why the idea is worth noticing
- the underlying assumption, mechanism, tradeoff, or uncertainty
- how it might connect to an AI product, workflow, research direction, or user behavior, but only when supported by the supplied material

Clearly distinguish transcript claims from your interpretation. Do not turn speculation or anecdote into fact.

## Beginner Bridge

Assume the reader is smart but may be early in learning AI. When the speaker's important point depends on an unfamiliar concept, do not summarize it as a chain of jargon. Briefly:

1. begin with a concrete situation or problem
2. explain what is difficult in plain Chinese
3. introduce the commonly used English term
4. walk through the causal logic
5. return to what the speaker is actually arguing

Use this only where it unlocks an important idea. Do not turn the whole episode into a beginner course. If the prerequisite would require a long detour, explain only what today's idea needs and flag the deeper topic as a possible Rabbit Hole.

## Style and integrity

Write Chinese-first and keep useful English AI/product/technical terminology. Use natural conversational Chinese rather than compressed expert shorthand or dictionary-style definitions. Do not mechanically translate the transcript or produce duplicate full English and Chinese versions. Avoid filler such as `本期节目讨论了` and avoid forced takeaways.

Use only the supplied transcript and metadata. Always include the exact episode URL from the JSON; never substitute a channel link.
