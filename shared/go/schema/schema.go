// Package schema is the Go view of Prova's cross-component contracts.
//
// It is the Go counterpart to the TypeScript package @prova/shared: the same error codes, proof
// shapes, IVMS101 subset, and API request/response types the mobile app and circuits use. Keep the
// two in lockstep — any breaking change here bumps SchemaVersion in both languages.
package schema

// SchemaVersion mirrors SCHEMA_VERSION in the TypeScript package. Bump on any breaking change to
// the shared contracts.
const SchemaVersion = "0.1.0"
