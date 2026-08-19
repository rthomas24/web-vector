# Two ways to parse expressions

A tokenizer turns a stream of characters into tokens such as identifiers, numbers and punctuation. The parser then consumes those tokens and builds a tree that reflects the grammar of the language, reporting an error at the first token that cannot continue any valid production.

Recursive descent parsers implement one function per grammar rule. Each function consumes the tokens that rule expects and calls the functions of the rules it references, so the call stack mirrors the shape of the parse tree while it is being built.

## Pratt parsing

Pratt parsing handles operator precedence by giving each operator a binding power. A loop keeps extending the current expression while the next operator binds more tightly than the surrounding context allows, which avoids one grammar rule per precedence level.

## Recovering from errors

Good error recovery matters more than speed for interactive tools. A common strategy is to synchronise on statement boundaries: after an error the parser skips tokens until it sees a semicolon or a keyword that starts a statement, then continues so that one typo does not hide every later error.
