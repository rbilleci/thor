---
name: author-content
description: Use whenever a task creates, rewrites, edits, or extends human-readable content. Apply these standards while authoring documentation, technical explanations, architectural decisions, requirements, reports, proposals, release notes, user-facing text, source comments, docstrings, and other prose. Produce concise, active-voice, evidence-based narratives with traceable figures, exact units, absolute references, defined terms, durable claims, semantic headings, stable identifiers, and explicit cross-references. Also use when reviewing or refactoring existing content. Do not use for code-only changes that create or modify no human-readable prose.
---


## Communication & Writing Standards

Communicate and write using a data-driven narrative format. Exclude filler words. Apply these rules to every generation task, including source comments and docstrings.

### Quantify Measured Events and Use Exact Units
Quantify measured performance and impact using numbers and precise units like United States Dollars (USD) or Gigabytes (GB). Vague adjectives and adverbs fail the "So what?" test because they carry no measurable fact. Never write "faster." Write "reduced 90th percentile (p90) latency by 45 milliseconds (ms)." Resolve a vague claim in one of three ways: cite a measured figure from a retained artifact, name the defining mechanism, or delete the claim. Never invent a figure to satisfy this rule. The Durable Figures section at ./standards.md#durable-figures governs counts of current state.

### Durable Figures

Requirement `STD-DURABLE-FIGURES` permits a published number that describes a completed, dated event with a retained artifact. "The load test of March 4, 2031 sustained 12,000 requests per second" stays true for every future reader.

Apply one test before writing a number. Ask whether a commit that never touches this sentence can make it false. Answer yes, and delete the number. Prose raises no alarm when it goes stale.

Name the mechanism instead of the magnitude. Never write "the 12 permitted codecs." Write "the codecs `SUPPORTED_CODECS` freezes." Two sets can hold the same count; only the name says which definition the code enforces. The name also stays true when the set grows.

The test covers enumerations. A sentence naming every current module, flag, or dependency breaks when someone adds one. Cite the directory, manifest, or command that defines the set.

State the command instead of its output. Never write "412 tests pass." Write "run the project gate's validate operation; its output states the count."

Prefer deletion over machine-guarding. A guarded number still costs one hand edit and one validation rerun per change. Publish a transient number only when a reader cannot act without it, and only when an automated check recomputes and compares it on every validation run. Cite the guard's path in the same sentence. An unguarded transient number is a defect.

A guard must not rewrite a document during validation. `AP-CANDIDATE` at ../AGENTS.md#candidate-and-validation invalidates every result when the candidate tree changes, so a self-updating figure must run before the candidate freezes.

### Computed Provenance

Requirement `STD-FIGURE-PROVENANCE` requires the writer to derive every figure from a retained artifact by computation, at writing time. Never transcribe a figure from memory, a conversation, or an earlier draft.

Name the population for every range, median, and rate. "8 to 41 ms across all 6 runs" and "8 to 22 ms in the 2 production runs" describe different sets. An unscoped range describes neither.

Dates are figures. Derive a past event's date from the artifact's own timestamp. Derive the date of the change under construction from the run that produced its evidence.

A figure with no retained artifact does not publish. Retain the derivation beside the evidence, or delete the sentence.

A claim about what a counter, field, or metric measures is a claim about the defining code. Read that source before writing the claim, and cite its path.

When an edit changes a published figure, sweep the repository for the superseded value. Run `grep -rn "<value>" --exclude-dir=.git .`. Never filter with `grep -v ".git/"`, which also drops document lines citing `.git/sap/` evidence paths and hides stale figures. Update every occurrence before submitting.

### Ban Ambiguous, Weasel, and Marketing Words
Eradicate ambiguous language and marketing terms. Words like "arguably" hide missing data. Words like "innovative" promote a subject without verifiable facts. Replace them with definitive statements. Replace "mostly" with a measured share such as "87% of requests" when a retained artifact supplies the figure. When no artifact exists, restructure the sentence to drop the claim.

### Brevity and Active Voice
Construct sentences using the active voice. The active voice identifies the actor immediately. Never write "the payload is processed." Write "the Application Programming Interface (API) processes the payload."

### Absolute References
Write for readers accessing the document on July 31, 2036. Replace relative time and space references with absolute facts. Never use "recently" or "next week." Use exact dates like "October 24, 2024."

### Contextual Knowledge and Traceable Data
Define every acronym, project-specific tool, or project-specific concept during its first appearance. Agents may assume common software-engineering, Git, and document terminology. Provide specific Uniform Resource Locators (URLs) or database queries for cited metrics.

### Narrative for Reasoning
Write technical reasoning and architectural decisions in pure paragraph format. Bullet points and diagrams obscure shallow thinking. Complete sentences force the writer to connect concepts with explicit logic.

### Author Anonymity
Omit author names, titles, and credentials. Documents must survive based entirely on the mathematical and logical strength of their data. Never generate "Written By" metadata.

### Defensive Writing
Anticipate specific reviewer questions. Justify every paragraph. When a sentence prompts the question "So what?", answer it immediately. Provide a factual statement, a sourced figure, a defining name, a "Yes," or a "No."

### Execution Validation
Run this verification sequence before finalizing output:
- [ ] Did I write every sentence in the active voice?
- [ ] Did I resolve every vague adjective into a sourced figure, a defining name, or a deletion?
- [ ] Did I eliminate all ambiguous and marketing words?
- [ ] Are all dates and locations absolute?
- [ ] Did I define all acronyms on first use?
- [ ] Did I cite exact sources for all metrics?
- [ ] Did I derive every figure and date from a retained artifact by computation, and name each population?
- [ ] Did I delete, or machine-guard and cite, every number a future commit can falsify?
- [ ] Did I format all technical reasoning as pure paragraphs?
- [ ] Did I remove all author metadata?

## Documentation Standards

Apply these rules when modifying any document.

### Ban Manual Heading Numbers
Exclude sequence numbers like "3" or "3.1" from headings. Adding one new heading renumbers every later section, which breaks every cross-reference that cites a number. Use semantic heading names. Never write "3. Architecture." Write "Architecture."

### Semantic Anchors for Cross-References
Build cross-references using explicit heading anchors. Never reference a section using a sequence number. When you modify a heading, execute a repository-wide search immediately. Update every broken link. Never write "See section 3.2." Write "See the Data Flow section at ./architecture.md#data-flow."

### Immutable Identifiers for Tracked Items
Track discrete requirements using immutable semantic identifiers. Use `PREFIX-SEMANTIC-SLUG` when the slug is unique. Add `-DISAMBIGUATOR` only when another requirement already uses that slug.

Freeze each identifier after publication. Titles may change without changing identifiers. Never reuse a deleted identifier.

Retain every published legacy identifier without modification. Apply the semantic format only to identifiers that have never been published.

The prefix identifies the governing document. The semantic slug identifies the requirement subject. The optional disambiguator distinguishes requirements with the same subject slug.

### Semantic Linking Over Positional Text
Delete positional text like "above" or "below." Moving content to a separate file breaks every positional reference to it. Use explicit file paths. Never write "See the configuration above." Write "See the Configuration Guide at ./config.md."

### Execution Validation
Run this verification sequence before finalizing any documentation refactor:
- [ ] Did I remove all manual sequence numbers from headings?
- [ ] Did I replace numbered cross-references with explicit anchor links?
- [ ] Did I assign immutable identifiers to tracked items?
- [ ] Did I omit a disambiguator when the semantic slug is unique?
- [ ] Did I execute a repository-wide search to update links after modifying a heading?
- [ ] Did I delete all positional text references?
