with (import <nixpkgs> {});

mkShell {
  name = "shumei";

  buildInputs = [
    nodejs yarn
  ];
}
