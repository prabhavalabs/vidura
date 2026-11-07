package accounts

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestHashPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("correct horse")
	require.NoError(t, err)
	assert.True(t, strings.HasPrefix(hash, "$argon2id$v=19$m=65536,t=3,p=2$"))
	assert.True(t, checkPassword(hash, "correct horse"))
	assert.False(t, checkPassword(hash, "correct horse "))
	again, err := HashPassword("correct horse")
	require.NoError(t, err)
	assert.NotEqual(t, hash, again, "each hash has its own salt")

	for _, bad := range []string{"", "plain", "$argon2i$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA", "$argon2id$v=19$m=99999999,t=3,p=2$c2FsdA$aGFzaA"} {
		assert.False(t, checkPassword(bad, "x"), bad)
	}
}

func TestSetPasswordAndSignIn(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	_, err := f.store.SetPassword(ctx, "owner@example.com", "short")
	assert.ErrorIs(t, err, ErrWeakPassword)
	_, err = f.store.SetPassword(ctx, "stranger@example.com", "long enough")
	assert.ErrorIs(t, err, ErrNotFound, "only existing accounts or owners")

	// The owner has no account yet: one is created, as a superuser.
	owner, err := f.store.SetPassword(ctx, "Owner@Example.com", "nipun-secret")
	require.NoError(t, err)
	assert.Equal(t, RoleSuperuser, owner.Role)

	got, err := f.store.PasswordSignIn(ctx, " OWNER@example.com ", "nipun-secret")
	require.NoError(t, err)
	assert.Equal(t, owner.ID, got.ID)

	_, err = f.store.PasswordSignIn(ctx, "owner@example.com", "wrong")
	assert.ErrorIs(t, err, ErrWrongPassword)
	_, err = f.store.PasswordSignIn(ctx, "nobody@example.com", "nipun-secret")
	assert.ErrorIs(t, err, ErrWrongPassword, "unknown accounts look like wrong passwords")
}

func TestPasswordSignInRefusesDisabledMembers(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	member := f.member(t, "m-sub", "member@example.com")
	_, err := f.store.SetPassword(ctx, "member@example.com", "member-pass")
	require.NoError(t, err)
	disabled := StatusDisabled
	_, err = f.store.UpdateUser(ctx, f.owner(t), member.ID, UserUpdate{Status: &disabled})
	require.NoError(t, err)

	_, err = f.store.PasswordSignIn(ctx, "member@example.com", "member-pass")
	assert.ErrorIs(t, err, ErrDisabled)
	_, err = f.store.PasswordSignIn(ctx, "member@example.com", "nope")
	assert.ErrorIs(t, err, ErrWrongPassword, "the status is only revealed after the password matches")
}

func TestSetPasswordSignsOutOtherSessions(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	owner := f.owner(t)
	token, _, err := f.store.CreateSession(ctx, owner.ID, SessionMeta{App: "admin"})
	require.NoError(t, err)
	_, err = f.store.SetPassword(ctx, owner.Email, "new-password")
	require.NoError(t, err)
	_, _, err = f.store.SessionUser(ctx, token, "admin")
	assert.Error(t, err)
}
