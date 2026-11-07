package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/prabhavalabs/vidura/backend/internal/agenthub"
	"github.com/prabhavalabs/vidura/backend/internal/agentproto"
	"github.com/prabhavalabs/vidura/backend/internal/auth"
	"github.com/prabhavalabs/vidura/backend/internal/chatgpt"
	"github.com/prabhavalabs/vidura/backend/internal/httpx"
	"github.com/prabhavalabs/vidura/backend/internal/learn"
)

// learnRoutes are the client portal's ways to learn from a video: study
// notes, the tutor chat, and pictures. Pictures are fetched through signed
// addresses (/media/images/…) so an <img> can show them.
func (s *Server) learnRoutes(mux *http.ServeMux) {
	c := s.deps.Auth.RequireClient
	mux.HandleFunc("GET /api/videos/{id}/insights/{kind}", c(s.getInsight))
	mux.HandleFunc("POST /api/videos/{id}/insights/{kind}", c(s.makeInsight))
	mux.HandleFunc("GET /api/videos/{id}/chat", c(s.videoChat))
	mux.HandleFunc("POST /api/videos/{id}/chat", c(s.askAboutVideo))
	mux.HandleFunc("GET /api/chats", c(s.listChats))
	mux.HandleFunc("POST /api/chats", c(s.askLibrary))
	mux.HandleFunc("GET /api/chats/{id}", c(s.getChat))
	mux.HandleFunc("PATCH /api/chats/{id}", c(s.renameChat))
	mux.HandleFunc("DELETE /api/chats/{id}", c(s.deleteChat))
	mux.HandleFunc("GET /api/messages/{id}/stream", c(s.streamAnswer))
	mux.HandleFunc("POST /api/messages/{id}/stop", c(s.stopAnswer))
	mux.HandleFunc("POST /api/messages/{id}/retry", c(s.retryAnswer))
	mux.HandleFunc("GET /api/videos/{id}/pictures", c(s.listPictures))
	mux.HandleFunc("POST /api/videos/{id}/pictures", c(s.makePicture))
	mux.HandleFunc("DELETE /api/pictures/{id}", c(s.deletePicture))
	mux.HandleFunc("GET /media/images/{id}", s.servePicture)
}

func (s *Server) learnReady(w http.ResponseWriter) bool {
	if s.deps.Learn == nil {
		httpx.WriteError(w, http.StatusServiceUnavailable, "learn_off", "Learning features aren't available on this server.")
		return false
	}
	return true
}

// learnError answers a learn error with the right status.
func learnError(w http.ResponseWriter, what string, err error) {
	switch {
	case errors.Is(err, learn.ErrNotFound):
		httpx.WriteError(w, http.StatusNotFound, "not_found", "Not found.")
	case errors.Is(err, learn.ErrNotReady):
		httpx.WriteError(w, http.StatusConflict, "not_ready", err.Error())
	case errors.Is(err, learn.ErrBadKind), errors.Is(err, learn.ErrBadLocale), errors.Is(err, learn.ErrEmptyQuestion):
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, learn.ErrBusy):
		httpx.WriteError(w, http.StatusTooManyRequests, "busy", err.Error())
	case errors.Is(err, learn.ErrAnswering):
		httpx.WriteError(w, http.StatusConflict, "answering", "Wait for the tutor to finish the current answer.")
	case errors.Is(err, learn.ErrNoAI), errors.Is(err, chatgpt.ErrNotInstalled), errors.Is(err, chatgpt.ErrAuth):
		httpx.WriteError(w, http.StatusServiceUnavailable, "ai_unavailable", "ChatGPT isn’t connected right now. Ask the owner to reconnect it.")
	case errors.Is(err, chatgpt.ErrQuota):
		httpx.WriteError(w, http.StatusServiceUnavailable, "ai_quota", "The ChatGPT usage limit was reached. Please try again later.")
	default:
		serverError(w, what, err)
	}
}

func locale(r *http.Request, fallback string) string {
	if l := r.URL.Query().Get("locale"); l != "" {
		return l
	}
	return fallback
}

func (s *Server) getInsight(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	in, err := s.deps.Learn.GetInsight(r.Context(), user.ID, r.PathValue("id"), r.PathValue("kind"), locale(r, user.Locale))
	if err != nil {
		learnError(w, "get insight", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, in)
}

func (s *Server) makeInsight(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	var body struct {
		Locale string `json:"locale"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	if body.Locale == "" {
		body.Locale = user.Locale
	}
	in, err := s.deps.Learn.MakeInsight(r.Context(), user.ID, r.PathValue("id"), r.PathValue("kind"), body.Locale)
	if err != nil {
		learnError(w, "make insight", err)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, in)
}

type question struct {
	Question string `json:"question"`
	Locale   string `json:"locale"`
	ThreadID string `json:"threadId"`
	Voice    bool   `json:"voice"`
	// AttachedVideoID is a video picked with "/" in the composer.
	AttachedVideoID string `json:"attachedVideoId"`
}

func (s *Server) videoChat(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	thread, err := s.deps.Learn.VideoThread(r.Context(), user.ID, r.PathValue("id"))
	if err != nil {
		learnError(w, "video chat", err)
		return
	}
	messages := []learn.Message{}
	if thread != nil {
		if messages, err = s.deps.Learn.Messages(r.Context(), user.ID, thread.ID); err != nil {
			learnError(w, "video chat", err)
			return
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"thread": thread, "messages": messages})
}

func (s *Server) askAboutVideo(w http.ResponseWriter, r *http.Request) {
	s.ask(w, r, r.PathValue("id"))
}

func (s *Server) askLibrary(w http.ResponseWriter, r *http.Request) {
	s.ask(w, r, "")
}

func (s *Server) ask(w http.ResponseWriter, r *http.Request, videoID string) {
	if !s.learnReady(w) {
		return
	}
	var body question
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	if body.Locale == "" {
		body.Locale = user.Locale
	}
	threadID := body.ThreadID
	if videoID != "" {
		threadID = ""
	}
	thread, messages, err := s.deps.Learn.Ask(r.Context(), user.ID, learn.Question{
		VideoID: videoID, ThreadID: threadID, Text: body.Question, Locale: body.Locale, Voice: body.Voice,
		AttachedVideoID: body.AttachedVideoID,
	})
	if err != nil {
		learnError(w, "ask", err)
		return
	}
	// The answer is being written: follow it at /api/messages/{id}/stream.
	httpx.WriteJSON(w, http.StatusAccepted, map[string]any{"thread": thread, "messages": messages})
}

func (s *Server) listChats(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	threads, err := s.deps.Learn.LibraryThreads(r.Context(), user.ID)
	if err != nil {
		learnError(w, "list chats", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"threads": threads})
}

func (s *Server) getChat(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	messages, err := s.deps.Learn.Messages(r.Context(), user.ID, r.PathValue("id"))
	if err != nil {
		learnError(w, "get chat", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"messages": messages})
}

func (s *Server) renameChat(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	var body struct {
		Title string `json:"title"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	thread, err := s.deps.Learn.RenameThread(r.Context(), user.ID, r.PathValue("id"), body.Title)
	if err != nil {
		if !errors.Is(err, learn.ErrNotFound) {
			httpx.WriteError(w, http.StatusBadRequest, "bad_title", "Use a title of 1 to 80 characters.")
			return
		}
		learnError(w, "rename chat", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"thread": thread})
}

func (s *Server) deleteChat(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	if err := s.deps.Learn.DeleteThread(r.Context(), user.ID, r.PathValue("id")); err != nil {
		learnError(w, "delete chat", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// streamAnswer follows an answer as Server-Sent Events:
//
//	event: snapshot  data: {"text": the whole answer so far}
//	event: delta     data: {"text": more of it}
//	event: end       data: {"message": the finished answer (status done, failed or stopped)}
//
// with a comment line every 15 s while nothing happens. Reconnecting starts
// again from a snapshot. The answer doesn't depend on this connection: it
// carries on when the learner leaves.
func (s *Server) streamAnswer(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	control := http.NewResponseController(w)
	started := false
	err := s.deps.Learn.Follow(r.Context(), user.ID, r.PathValue("id"), func(e learn.Event) error {
		if !started {
			started = true
			h := w.Header()
			h.Set("Content-Type", "text/event-stream; charset=utf-8")
			h.Set("Cache-Control", "no-cache, no-transform")
			// nginx buffers proxied responses unless told not to.
			h.Set("X-Accel-Buffering", "no")
			w.WriteHeader(http.StatusOK)
		}
		if e.Type == "ping" {
			_, err := io.WriteString(w, ": ping\n\n")
			if err == nil {
				err = control.Flush()
			}
			return err
		}
		data, err := json.Marshal(e)
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Type, data); err != nil {
			return err
		}
		return control.Flush()
	})
	if err != nil && !started {
		learnError(w, "stream answer", err)
	}
}

// stopAnswer stops an answer being written; what was written is kept.
func (s *Server) stopAnswer(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	message, err := s.deps.Learn.Stop(r.Context(), user.ID, r.PathValue("id"))
	if err != nil {
		learnError(w, "stop answer", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"message": message})
}

// retryAnswer writes a failed or stopped answer again.
func (s *Server) retryAnswer(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	var body struct {
		Locale string `json:"locale"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	if body.Locale == "" {
		body.Locale = user.Locale
	}
	message, err := s.deps.Learn.Retry(r.Context(), user.ID, r.PathValue("id"), body.Locale)
	if err != nil {
		learnError(w, "retry answer", err)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, map[string]any{"message": message})
}

func (s *Server) signer() learn.Signer {
	return learn.Signer{Secret: s.deps.Config.Secret, Base: s.deps.Config.APIOrigin()}
}

func (s *Server) listPictures(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	pictures, err := s.deps.Learn.Pictures(r.Context(), user.ID, r.PathValue("id"), s.signer())
	if err != nil {
		learnError(w, "list pictures", err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"pictures": pictures})
}

func (s *Server) makePicture(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	var body struct {
		Concept string `json:"concept"`
		Locale  string `json:"locale"`
	}
	if !httpx.DecodeJSON(w, r, &body) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	if body.Locale == "" {
		body.Locale = user.Locale
	}
	picture, err := s.deps.Learn.Illustrate(r.Context(), user.ID, r.PathValue("id"), body.Concept, body.Locale)
	if err != nil {
		learnError(w, "make picture", err)
		return
	}
	httpx.WriteJSON(w, http.StatusAccepted, map[string]any{"picture": picture})
}

func (s *Server) deletePicture(w http.ResponseWriter, r *http.Request) {
	if !s.learnReady(w) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	if err := s.deps.Learn.DeletePicture(r.Context(), user.ID, r.PathValue("id")); err != nil {
		learnError(w, "delete picture", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// servePicture answers a signed picture address; no session is needed, the
// signature (valid for an hour) is the permission.
func (s *Server) servePicture(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	query := r.URL.Query()
	if s.deps.Learn == nil || !s.signer().Valid(id, query.Get("e"), query.Get("s")) {
		http.NotFound(w, r)
		return
	}
	path, err := s.deps.Learn.PictureFile(r.Context(), id)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := "image/jpeg"
	if strings.HasSuffix(path, ".png") {
		contentType = "image/png"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-site")
	http.ServeContent(w, r, "", info.ModTime(), file)
}

// voiceRoutes turns a spoken question into text with the paired Mac.
func (s *Server) voiceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/voice", s.deps.Auth.RequireClient(s.voice))
}

// voice takes a recording as the request body (Content-Type: the audio
// type) and returns its words and their language.
func (s *Server) voice(w http.ResponseWriter, r *http.Request) {
	audioType, _, _ := strings.Cut(r.Header.Get("Content-Type"), ";")
	audioType = strings.ToLower(strings.TrimSpace(audioType))
	if _, ok := agentproto.SpeechFormats[audioType]; !ok {
		httpx.WriteError(w, http.StatusUnsupportedMediaType, "bad_audio", "Send a webm, ogg, mp4, aac, mp3 or wav recording.")
		return
	}
	audio, err := io.ReadAll(http.MaxBytesReader(w, r.Body, agentproto.MaxSpeechBytes))
	if err != nil {
		httpx.WriteError(w, http.StatusRequestEntityTooLarge, "too_long", "Keep a voice question under two minutes.")
		return
	}
	if len(audio) == 0 {
		httpx.WriteError(w, http.StatusBadRequest, "empty", "The recording was empty.")
		return
	}
	text, language, err := s.hub.Speech(r.Context(), audio, audioType)
	switch {
	case errors.Is(err, agenthub.ErrNoTranscriber):
		httpx.WriteError(w, http.StatusServiceUnavailable, "no_mac",
			"Voice questions need the owner’s Mac to be on, with Whisper large-v3 installed. Type your question instead.")
	case errors.Is(err, agenthub.ErrNoSpeech):
		httpx.WriteError(w, http.StatusUnprocessableEntity, "no_speech", "No words were heard. Try again, a little closer to the microphone.")
	case err != nil:
		httpx.WriteError(w, http.StatusBadGateway, "speech_failed", "Couldn’t understand the recording: "+err.Error())
	default:
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"text": text, "language": language})
	}
}
