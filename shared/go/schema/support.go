package schema

// In-app support conversations (mobile <-> Go backend <-> operator console). Mirrors support.ts.
//
// Like the rest of this API, a conversation is addressed by the opaque userId and nothing else. The
// message body is free text a person typed, so it is the one field here that could contain anything
// — which is exactly why there is no other field for personal details to land in.

// Support message authors.
const (
	// AuthorUser is the person using the app.
	AuthorUser = "user"
	// AuthorTeam is Prova. Not a named individual: attributing replies is a decision for when more
	// than one person answers them.
	AuthorTeam = "team"
)

// MaxSupportBodyChars bounds one stored message. Generous enough to describe a problem, small
// enough that the endpoint cannot be used as free storage.
//
// Deliberately above MaxContactMessageChars: a website enquiry arrives with the sender's name and
// email prepended, so a message at the form's own limit still fits here. Without the gap, somebody
// who filled the box exactly to the maximum would be rejected for a header they never typed.
const MaxSupportBodyChars = 6000

// MaxContactMessageChars bounds what the website contact form accepts from a visitor.
const MaxContactMessageChars = 5000

// SupportMessage is one entry in a conversation.
type SupportMessage struct {
	ID     int64  `json:"id"`
	Author string `json:"author"`
	Body   string `json:"body"`
	SentAt string `json:"sentAt"` // ISO 8601
}

// SupportThreadRecord is one conversation as the operator inbox sees it.
type SupportThreadRecord struct {
	UserID string `json:"userId"`
	Status string `json:"status"`
	// Unread counts messages the team has not answered or acknowledged.
	Unread        int    `json:"unread"`
	LastMessage   string `json:"lastMessage,omitempty"`
	LastAuthor    string `json:"lastAuthor,omitempty"`
	LastMessageAt string `json:"lastMessageAt"` // ISO 8601
	CreatedAt     string `json:"createdAt"`     // ISO 8601
}

// SendSupportMessageRequest is the body used by both the app and the console to post a message.
type SendSupportMessageRequest struct {
	Body string `json:"body"`
}

// SupportThreadView is a conversation plus its messages, which is what a chat screen needs to open.
type SupportThreadView struct {
	UserID   string           `json:"userId"`
	Status   string           `json:"status"`
	Unread   int              `json:"unread"`
	Messages []SupportMessage `json:"messages"`
}
