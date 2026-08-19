# Ratenbegrenzung verständlich erklärt

Eine Ratenbegrenzung schützt einen Dienst davor, von zu vielen Anfragen in kurzer Zeit überlastet zu werden. Statt unter Last unvorhersehbar auszufallen, lehnt ein begrenzter Dienst überzählige Anfragen kontrolliert ab und teilt dem Client mit, wann er es erneut versuchen darf.

## Token-Bucket

Der Token-Bucket-Algorithmus führt einen Zähler verfügbarer Token, der sich mit fester Rate bis zu einer Höchstkapazität auffüllt. Jede Anfrage verbraucht ein Token; ist der Eimer leer, wird die Anfrage abgelehnt. Weil sich Token im Leerlauf ansammeln, verträgt der Eimer kurze Lastspitzen, ohne die langfristige Durchschnittsrate zu überschreiten.

## Leaky-Bucket

Ein Leaky-Bucket glättet den Verkehr, statt Spitzen zu tolerieren: Anfragen landen in einer Warteschlange, die mit konstanter Rate abfließt; kommen Anfragen bei voller Warteschlange an, werden sie verworfen.
