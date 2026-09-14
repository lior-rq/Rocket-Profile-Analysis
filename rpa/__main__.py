from .cli import main

if __name__ == "__main__":  # guarded: process-pool workers re-import this module under spawn
    main()
