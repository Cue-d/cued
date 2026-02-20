/**
 * MergeContactSheet - Bottom sheet for manually merging two contacts.
 *
 * Two-step flow: (1) search and pick a contact, (2) preview + resolve conflicts + confirm.
 */

import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  PlatformColor,
  ActivityIndicator,
} from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useQuery, useMutation } from "convex/react";
import { api } from "@cued/convex";
import type { Id } from "@cued/convex/convex/_generated/dataModel";
import { getInitials, MERGE_CONFLICT_FIELD_LABELS } from "@cued/shared";

type FieldResolutions = {
  displayName?: "primary" | "secondary";
  company?: "primary" | "secondary";
  notes?: "primary" | "secondary" | "merge";
};

interface MergeContactSheetProps {
  visible: boolean;
  onClose: () => void;
  primaryContactId: Id<"contacts">;
}

export function MergeContactSheet({ visible, onClose, primaryContactId }: MergeContactSheetProps) {
  const [step, setStep] = useState<"search" | "preview">("search");
  const [secondaryContactId, setSecondaryContactId] = useState<Id<"contacts"> | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [resolutions, setResolutions] = useState<FieldResolutions>({});
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manualMerge = useMutation(api.contacts.manualMerge);

  // Search contacts
  const searchResults = useQuery(
    api.contacts.getContacts,
    visible && step === "search" ? { searchQuery: searchQuery || undefined, limit: 20 } : "skip"
  );

  // Merge preview
  const preview = useQuery(
    api.contacts.mergePreview,
    secondaryContactId ? { primaryContactId, secondaryContactId } : "skip"
  );

  const filteredContacts = useMemo(() => {
    if (!searchResults?.contacts) return [];
    return searchResults.contacts.filter((c) => c._id !== primaryContactId);
  }, [searchResults?.contacts, primaryContactId]);

  const handleReset = useCallback(() => {
    setStep("search");
    setSecondaryContactId(null);
    setSearchQuery("");
    setResolutions({});
    setIsMerging(false);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    onClose();
    setTimeout(handleReset, 200);
  }, [onClose, handleReset]);

  const handleSelectContact = useCallback((contactId: Id<"contacts">) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSecondaryContactId(contactId);
    setStep("preview");
  }, []);

  const handleMerge = useCallback(async () => {
    if (!secondaryContactId) return;
    setIsMerging(true);
    setError(null);
    try {
      await manualMerge({
        primaryContactId,
        secondaryContactId,
        fieldResolutions: Object.keys(resolutions).length > 0 ? resolutions : undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      handleClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setIsMerging(false);
    }
  }, [secondaryContactId, primaryContactId, resolutions, manualMerge, handleClose]);

  const handleBack = useCallback(() => {
    setStep("search");
    setSecondaryContactId(null);
    setResolutions({});
    setError(null);
  }, []);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1, backgroundColor: PlatformColor("systemGroupedBackground") }}
      >
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 12,
          }}
        >
          {step === "preview" ? (
            <Pressable onPress={handleBack} hitSlop={8}>
              <Text style={{ fontSize: 17, color: PlatformColor("systemBlue") }}>Back</Text>
            </Pressable>
          ) : (
            <View style={{ width: 50 }} />
          )}
          <Text style={{ fontSize: 17, fontWeight: "600", color: PlatformColor("label") }}>
            {step === "search" ? "Merge with..." : "Merge Contacts"}
          </Text>
          <Pressable onPress={handleClose} hitSlop={8}>
            <Text style={{ fontSize: 17, color: PlatformColor("systemBlue") }}>Cancel</Text>
          </Pressable>
        </View>

        {step === "search" ? (
          <SearchStep
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            contacts={filteredContacts}
            isLoading={searchResults === undefined}
            onSelect={handleSelectContact}
          />
        ) : (
          <PreviewStep
            preview={preview}
            resolutions={resolutions}
            onResolutionChange={setResolutions}
            onMerge={handleMerge}
            isMerging={isMerging}
            error={error}
          />
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Step 1: Search and pick a contact */
function SearchStep({
  searchQuery,
  onSearchChange,
  contacts,
  isLoading,
  onSelect,
}: {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  contacts: Array<{ _id: string; displayName: string; company?: string | null }>;
  isLoading: boolean;
  onSelect: (id: Id<"contacts">) => void;
}) {
  return (
    <>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: PlatformColor("tertiarySystemFill"),
            borderRadius: 10,
            paddingHorizontal: 10,
            height: 36,
          }}
        >
          <SymbolView name="magnifyingglass" size={16} tintColor={PlatformColor("secondaryLabel")} />
          <TextInput
            value={searchQuery}
            onChangeText={onSearchChange}
            placeholder="Search contacts..."
            placeholderTextColor={PlatformColor("placeholderText")}
            style={{
              flex: 1,
              fontSize: 16,
              color: PlatformColor("label"),
              marginLeft: 6,
              paddingVertical: 0,
            }}
            autoFocus
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </View>

      {isLoading ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator />
        </View>
      ) : contacts.length === 0 ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ fontSize: 16, color: PlatformColor("secondaryLabel") }}>
            No contacts found
          </Text>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(item) => item._id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 16 }}
          renderItem={({ item, index }) => (
            <Pressable
              onPress={() => onSelect(item._id as Id<"contacts">)}
              style={[
                {
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 12,
                  paddingHorizontal: 12,
                },
                index === 0 && {
                  borderTopLeftRadius: 12,
                  borderTopRightRadius: 12,
                },
                index > 0 && {
                  borderTopWidth: 1,
                  borderTopColor: PlatformColor("separator"),
                },
                {
                  backgroundColor: PlatformColor("secondarySystemGroupedBackground"),
                },
              ]}
              className="active:opacity-70"
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: PlatformColor("tertiarySystemFill"),
                  marginRight: 12,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "500", color: PlatformColor("secondaryLabel") }}>
                  {getInitials(item.displayName)}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 16, color: PlatformColor("label") }} numberOfLines={1}>
                  {item.displayName}
                </Text>
                {item.company && (
                  <Text style={{ fontSize: 14, color: PlatformColor("secondaryLabel"), marginTop: 1 }} numberOfLines={1}>
                    {item.company}
                  </Text>
                )}
              </View>
              <SymbolView name="chevron.right" size={12} tintColor={PlatformColor("tertiaryLabel")} />
            </Pressable>
          )}
        />
      )}
    </>
  );
}

/** Step 2: Preview + conflict resolution + confirm */
function PreviewStep({
  preview,
  resolutions,
  onResolutionChange,
  onMerge,
  isMerging,
  error,
}: {
  preview: {
    primary: { displayName: string };
    secondary: { displayName: string };
    conflicts: Array<{ field: string; primaryValue?: string; secondaryValue?: string }>;
    handlesToMove: Array<{ type: string; value: string; platform: string }>;
    handlesToDedupe: Array<{ type: string; value: string; platform: string }>;
    impact: { conversationsAffected: number; messagesAffected: number; actionsAffected: number };
  } | null | undefined;
  resolutions: FieldResolutions;
  onResolutionChange: (r: FieldResolutions) => void;
  onMerge: () => void;
  isMerging: boolean;
  error: string | null;
}) {
  if (preview === undefined) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (preview === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 }}>
        <Text style={{ fontSize: 16, color: PlatformColor("secondaryLabel"), textAlign: "center" }}>
          That contact is no longer available. Go back and choose another contact to merge.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={[null]} // Single item to enable scroll
      keyExtractor={() => "preview"}
      contentContainerStyle={{ padding: 16 }}
      renderItem={() => (
        <View>
          {/* Merge description */}
          <Text style={{ fontSize: 15, color: PlatformColor("secondaryLabel"), marginBottom: 20 }}>
            <Text style={{ fontWeight: "600", color: PlatformColor("label") }}>{preview.secondary.displayName}</Text>
            {" will be merged into "}
            <Text style={{ fontWeight: "600", color: PlatformColor("label") }}>{preview.primary.displayName}</Text>
            {" and deleted."}
          </Text>

          {/* Conflicts */}
          {preview.conflicts.length > 0 && (
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: PlatformColor("secondaryLabel"), marginBottom: 8, marginHorizontal: 4 }}>
                RESOLVE CONFLICTS
              </Text>
              {preview.conflicts.map((conflict) => (
                <View key={conflict.field} style={{ marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, color: PlatformColor("secondaryLabel"), marginBottom: 6, marginHorizontal: 4 }}>
                    {MERGE_CONFLICT_FIELD_LABELS[conflict.field] ?? conflict.field}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <ConflictOption
                      label={conflict.primaryValue || "\u2014"}
                      selected={resolutions[conflict.field as keyof FieldResolutions] !== "secondary" && resolutions[conflict.field as keyof FieldResolutions] !== "merge"}
                      onPress={() => onResolutionChange({ ...resolutions, [conflict.field]: "primary" })}
                    />
                    <ConflictOption
                      label={conflict.secondaryValue || "\u2014"}
                      selected={resolutions[conflict.field as keyof FieldResolutions] === "secondary"}
                      onPress={() => onResolutionChange({ ...resolutions, [conflict.field]: "secondary" })}
                    />
                  </View>
                  {conflict.field === "notes" && (
                    <View style={{ marginTop: 8 }}>
                      <ConflictOption
                        label="Merge both notes"
                        selected={resolutions.notes === "merge"}
                        onPress={() => onResolutionChange({ ...resolutions, notes: "merge" })}
                      />
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}

          {error && (
            <Text style={{ fontSize: 14, color: PlatformColor("systemRed"), marginBottom: 12, textAlign: "center" }}>
              {error}
            </Text>
          )}

          {/* Merge button */}
          <Pressable
            onPress={onMerge}
            disabled={isMerging}
            style={{
              backgroundColor: PlatformColor("systemBlue"),
              borderRadius: 12,
              paddingVertical: 14,
              alignItems: "center",
              justifyContent: "center",
              opacity: isMerging ? 0.6 : 1,
            }}
            className="active:opacity-80"
          >
            {isMerging ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={{ fontSize: 17, fontWeight: "600", color: "white" }}>
                Merge Contacts
              </Text>
            )}
          </Pressable>
        </View>
      )}
    />
  );
}

/** Selectable option for conflict resolution */
function ConflictOption({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: selected ? PlatformColor("systemBlue") : PlatformColor("separator"),
        backgroundColor: selected
          ? PlatformColor("tertiarySystemFill")
          : PlatformColor("secondarySystemGroupedBackground"),
      }}
      className="active:opacity-70"
    >
      <Text
        style={{ fontSize: 15, color: PlatformColor("label") }}
        numberOfLines={2}
      >
        {label}
      </Text>
    </Pressable>
  );
}
