module github.com/prova/backend

go 1.23

require github.com/prova/shared v0.1.0

// prova-shared is consumed from the local polyrepo checkout until it is published.
replace github.com/prova/shared => ../shared/go
