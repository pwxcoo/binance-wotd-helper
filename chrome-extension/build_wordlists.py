from pathlib import Path


MIN_LENGTH = 4
MAX_LENGTH = 10


def normalize_words(source_path: Path) -> list[str]:
    seen: set[str] = set()
    words: list[str] = []

    with source_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            word = raw_line.strip().lower()
            if not word.isalpha():
                continue
            if not (MIN_LENGTH <= len(word) <= MAX_LENGTH):
                continue
            if word in seen:
                continue
            seen.add(word)
            words.append(word)

    words.sort()
    return words


def write_wordlist(source_name: str, target_name: str) -> None:
    extension_dir = Path(__file__).resolve().parent
    repo_dir = extension_dir.parent
    source_path = repo_dir / source_name
    target_path = extension_dir / "wordlists" / target_name
    target_path.parent.mkdir(parents=True, exist_ok=True)

    words = normalize_words(source_path)
    payload = "\n".join(words) + "\n"
    target_path.write_text(payload, encoding="utf-8")
    print(f"Wrote {len(words)} words to {target_path}")


def main() -> None:
    write_wordlist("common_words.txt", "common_words.txt")
    write_wordlist("words.txt", "full_words.txt")


if __name__ == "__main__":
    main()
