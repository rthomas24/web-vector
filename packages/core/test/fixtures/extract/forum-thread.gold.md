# Parsers: recursive descent vs Pratt

### ada

Starting a thread on parser design. A tokenizer turns a stream of characters into tokens such as identifiers, numbers and punctuation. The parser then consumes those tokens and builds a tree that reflects the grammar of the language, reporting an error at the first token that cannot continue any valid production.

Recursive descent parsers implement one function per grammar rule. Each function consumes the tokens that rule expects and calls the functions of the rules it references, so the call stack mirrors the shape of the parse tree while it is being built.

### brendan

Pratt parsing handles operator precedence by giving each operator a binding power. A loop keeps extending the current expression while the next operator binds more tightly than the surrounding context allows, which avoids one grammar rule per precedence level. I switched our expression parser to this last year and deleted eleven grammar rules.

### chen

Neither approach helps if you ignore recovery. Good error recovery matters more than speed for interactive tools. A common strategy is to synchronise on statement boundaries: after an error the parser skips tokens until it sees a semicolon or a keyword that starts a statement, then continues so that one typo does not hide every later error.

### ada

Agreed on recovery. For what it is worth the Pratt loop composes fine with statement-level synchronisation.
