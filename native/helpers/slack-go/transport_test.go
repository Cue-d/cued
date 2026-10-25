package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCredentialTransportDestinations(t *testing.T) {
	for _, target := range []string{"http://slack.com/api/", "https://evil.example/file", "https://slack.com.evil.example/file", "https://evil.slack.com/file", "https://slack.com:8443/api/", "https://user@slack.com/api/", "http://127.0.0.1:1234/", "https://files.slack.com.evil.example/file", "https://slack.com/api/", "https://files.slack.com/file"} {
		t.Run(target, func(t *testing.T) {
			called := false
			transport := cookieTransport{cookie: "secret", base: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				called = true
				if r.Header.Get("Cookie") != "d=secret" || r.Header.Get("Authorization") != "Bearer secret" {
					t.Error("missing credentials")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(""))}, nil
			})}
			req, _ := http.NewRequest(http.MethodPost, target, strings.NewReader("token=secret"))
			req.Header.Set("Authorization", "Bearer secret")
			resp, err := transport.RoundTrip(req)
			allowed := target == "https://slack.com/api/" || target == "https://files.slack.com/file"
			if (err == nil) != allowed || called != allowed {
				t.Fatalf("allowed=%v called=%v error=%v", allowed, called, err)
			}
			if resp != nil {
				resp.Body.Close()
			}
			if req.Header.Get("Cookie") != "" {
				t.Fatal("mutated caller request")
			}
		})
	}
}

func TestSlackAPIOverrideValidation(t *testing.T) {
	for _, target := range []string{"http://slack.com/api/", "https://evil.example/api/", "http://localhost:1234/", "http://127.0.0.1:1234/?token=x", "http://user@127.0.0.1:1234/"} {
		if _, err := newSlackClient(slackCredentials{Token: "token", Cookie: "cookie"}, target); err == nil {
			t.Errorf("accepted %s", target)
		}
	}
}

func TestSlackRedirectDoesNotLeakCredentials(t *testing.T) {
	for _, status := range []int{301, 302, 303, 307, 308} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			leaked := false
			sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked = true }))
			defer sink.Close()
			source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Cookie") != "d=cookie" {
					t.Error("missing initial cookie")
				}
				http.Redirect(w, r, sink.URL, status)
			}))
			defer source.Close()
			client, err := newSlackClient(slackCredentials{Token: "token", Cookie: "cookie"}, source.URL+"/")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.AuthTestContext(context.Background()); err == nil {
				t.Fatal("expected blocked redirect")
			}
			if leaked {
				t.Fatal("cross-origin redirect reached destination")
			}
		})
	}
}

func TestSlackSameOriginRedirectAndDowngrade(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/auth.test" {
			http.Redirect(w, r, "/result", http.StatusTemporaryRedirect)
			return
		}
		if r.Header.Get("Cookie") != "d=cookie" {
			t.Error("missing redirected cookie")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("token") != "token" {
			t.Error("missing redirected token")
		}
		io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	client, err := newSlackClient(slackCredentials{Token: "token", Cookie: "cookie"}, server.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.AuthTestContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	origin, _ := http.NewRequest(http.MethodGet, "https://slack.com/api/", nil)
	for _, target := range []string{"http://slack.com/api/", "https://files.slack.com/file"} {
		req, _ := http.NewRequest(http.MethodGet, target, nil)
		if err := checkSlackRedirect(req, []*http.Request{origin}); err == nil {
			t.Errorf("accepted %s", target)
		}
	}
}

// Exercise the dependency's public download API as well as our transport guard.
func TestSlackRemoteFileURLIsRejected(t *testing.T) {
	client, err := newSlackClient(slackCredentials{Token: "token", Cookie: "cookie"}, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"https://attacker.example/remote-file", "http://files.slack.com/file"} {
		if err := client.GetFileContext(context.Background(), target, io.Discard); err == nil {
			t.Errorf("accepted remote file URL %s", target)
		}
	}
}
